import { spawn as nodeSpawn } from 'node:child_process';
import { AbortWaitError } from '../../utils/abort';
import {
  adaptDirectSearch,
  cleanupBudget,
  DEFAULT_SEARCH_KILL_GRACE_MS,
  type ManagedSearch,
  toErrorMessage,
  waitForManagedCleanup,
  watchSearchCompletion,
} from '../../utils/process-output';
import { resolveGlobCliWithAutoInstall } from './resolver';
import { buildRgCommand } from './rg-args';
import {
  collectMatchedPaths,
  emptyResult,
  sliceLimit,
  watchStderr,
} from './runner-output';
import type { GlobRunner } from './types';

interface SpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  killGraceMs?: number;
  postExitDrainMs?: number;
}

export interface RunnerDeps {
  resolve: typeof resolveGlobCliWithAutoInstall;
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ManagedSearch;
  killGraceMs?: number;
  postExitDrainMs?: number;
  // Final-result budget after an early stop, independent of the search timeout.
  cleanupWaitMs?: number;
}

const isTimeoutReason = (signal: AbortSignal) =>
  signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
const INTERRUPT_EXIT_CODES = { timeout: 124, cancel: 130, limit: 0 } as const;

export function createDefaultRunnerDeps(): RunnerDeps {
  // The rg on PATH may be a wrapper script that runs ripgrep as a child. On
  // POSIX the search leads its own process group, so a stop reaches it too.
  const group = process.platform !== 'win32';
  return {
    killGraceMs: DEFAULT_SEARCH_KILL_GRACE_MS,
    resolve: resolveGlobCliWithAutoInstall,
    spawn: (cmd, args, options) =>
      adaptDirectSearch(
        nodeSpawn(cmd, args, {
          cwd: options.cwd,
          stdio: options.stdio,
          detached: group,
        }),
        {
          killProcessGroup: group,
          killGraceMs: options.killGraceMs,
          postCloseDrainMs: options.postExitDrainMs,
        },
      ),
  };
}

export function createRipgrepRunner(
  deps: RunnerDeps = createDefaultRunnerDeps(),
): GlobRunner {
  return async (input, signal) => {
    const state = { timedOut: false, cancelled: false, limitReached: false };
    let command: string[] | undefined;
    const currentCommand = () => (command ??= buildRgCommand(input));
    const interruptedResult = () =>
      emptyResult(input, currentCommand(), {
        incomplete: true,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        exitCode: INTERRUPT_EXIT_CODES[state.cancelled ? 'cancel' : 'timeout'],
      });
    const controller = new AbortController();
    let search: ManagedSearch | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => undefined;
    let stopStdout: () => void = () => undefined;
    let stopStderr: () => void = () => undefined;
    let clearDone: () => void = () => undefined;
    let stopping = false;
    let stopRequestedAt: number | undefined;

    if (signal.aborted) {
      state.timedOut = isTimeoutReason(signal);
      state.cancelled = !state.timedOut;
      return interruptedResult();
    }

    const stop = () => {
      if (!search || stopping) return;
      stopping = true;
      stopRequestedAt = performance.now();
      search.stop();
    };

    let finishInterrupt!: (value: 'cancel' | 'timeout') => void;
    const interruptResult = new Promise<'cancel' | 'timeout'>((resolve) => {
      finishInterrupt = resolve;
    });

    const onAbort = () => {
      const timedOut = isTimeoutReason(signal);
      state.timedOut ||= timedOut;
      state.cancelled ||= !timedOut;
      controller.abort();
      stop();
      finishInterrupt(timedOut ? 'timeout' : 'cancel');
    };

    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => {
      signal.removeEventListener('abort', onAbort);
    };

    // The deadline covers the whole run: binary resolution (including
    // auto-install) and the search process itself.
    timeout = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
      stop();
      finishInterrupt('timeout');
    }, input.timeoutMs);
    timeout.unref?.();

    try {
      const resolved = await Promise.race([
        deps
          .resolve(undefined, controller.signal, {
            allowAutoInstall: input.allowAutoInstall === true,
          })
          .then((cli) => ({ type: 'cli' as const, cli }))
          .catch((error) => ({ type: 'resolve-error' as const, error })),
        interruptResult,
      ]);

      if (resolved === 'cancel' || resolved === 'timeout') {
        return interruptedResult();
      }

      if (resolved.type === 'resolve-error') {
        if (
          resolved.error instanceof AbortWaitError ||
          controller.signal.aborted
        ) {
          return interruptedResult();
        }

        return emptyResult(input, currentCommand(), {
          exitCode: 1,
          error: toErrorMessage(resolved.error),
        });
      }

      const cli = resolved.cli;

      command = buildRgCommand(input, cli.path);
      try {
        const [cmd, ...args] = command;
        // Recheck at spawn: the CLI race may settle before abort is delivered.
        if (signal.aborted || controller.signal.aborted) {
          return interruptedResult();
        }
        search = deps.spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: input.searchPath,
          killGraceMs: deps.killGraceMs,
          postExitDrainMs: deps.postExitDrainMs,
        });
      } catch (error) {
        return emptyResult(input, currentCommand(), {
          exitCode: 1,
          error: toErrorMessage(error),
        });
      }

      const child = search.child;

      let finishLimit: ((value: 'limit') => void) | undefined;
      const limitResult = new Promise<'limit'>((resolve) => {
        finishLimit = resolve;
      });

      const stdout = collectMatchedPaths(input, child.stdout, {
        onOverflow: () => {
          if (state.limitReached) return;
          state.limitReached = true;
          stop();
          finishLimit?.('limit');
        },
      });
      const stderr = watchStderr(child.stderr);
      stopStdout = stdout.stop;
      stopStderr = stderr.stop;

      const completion = watchSearchCompletion(search, stop);
      clearDone = completion.clear;

      // Also handle a synchronous abort from an injected spawn implementation.
      if (controller.signal.aborted) stop();

      const ended = await Promise.race([
        completion.done,
        interruptResult,
        limitResult,
      ]);
      const earlyStop = typeof ended === 'string';
      let finalExit = !earlyStop ? ended : undefined;
      let cleanupError: string | undefined;
      if (earlyStop) {
        // Search has ended. Do not let its deadline reclassify a limit stop
        // while we wait for the independently bounded cleanup protocol.
        clearTimeout(timeout);
        removeAbort();
        const budget = cleanupBudget({
          killGraceMs: deps.killGraceMs,
          postCloseDrainMs: deps.postExitDrainMs,
          cleanupWaitMs: deps.cleanupWaitMs,
        });
        const remaining = Math.max(
          0,
          budget - (performance.now() - (stopRequestedAt ?? performance.now())),
        );
        const cleanup = await waitForManagedCleanup(
          search.completed,
          remaining,
        );
        if (cleanup) finalExit = cleanup;
        else {
          cleanupError =
            'Search cleanup unconfirmed: cleanup wait deadline exceeded';
        }
      }
      const incomplete = state.timedOut || state.cancelled;
      const output = stdout.read();
      const err = stderr.read();
      const result = sliceLimit(input, output);
      const exitCode = earlyStop
        ? (finalExit?.code ??
          search.readExit()?.code ??
          INTERRUPT_EXIT_CODES[ended])
        : (ended.code ?? 1);
      const interrupted =
        state.timedOut || state.cancelled || state.limitReached;
      const exitError =
        cleanupError ??
        finalExit?.error ??
        (!interrupted && finalExit?.signal
          ? `rg terminated by signal ${finalExit.signal}`
          : undefined);

      // Native parity: exit 2 with rows already collected is a partial
      // success (e.g. a permission-denied subtree), not a hard failure.
      const partialByExitCode =
        !earlyStop && ended.code === 2 && result.length > 0;
      const failed =
        Boolean(exitError) ||
        (!interrupted &&
          !partialByExitCode &&
          exitCode !== 0 &&
          exitCode !== 1);

      return {
        files: result,
        count: result.length,
        backend: 'rg',
        truncated: state.limitReached || output.length > input.limit,
        incomplete: incomplete || partialByExitCode || failed,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        exitCode,
        command,
        cwd: input.searchPath,
        stderr: err,
        ...(failed
          ? {
              error:
                exitError ?? (err.trim() || `rg exited with code ${exitCode}`),
            }
          : {}),
      };
    } catch (error) {
      return emptyResult(input, currentCommand(), {
        exitCode: 1,
        error: toErrorMessage(error),
      });
    } finally {
      clearTimeout(timeout);
      removeAbort();
      clearDone();
      stopStdout();
      stopStderr();
      // Reader guards survive destruction; child listeners last until close/escalation.
    }
  };
}

export const runRipgrep = createRipgrepRunner();

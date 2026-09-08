import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  spawnSupervised,
} from '../../utils/process-supervisor';
import { AbortWaitError, resolveGlobCliWithAutoInstall } from './resolver';
import { buildRgCommand } from './rg-args';
import {
  collectMatchedPaths,
  emptyResult,
  sliceLimit,
  toErrorMessage,
  watchStderr,
} from './runner-output';
import {
  adaptSupervisedSearch,
  DEFAULT_CLEANUP_WAIT_MS,
  type ManagedSearch,
  POST_EXIT_DRAIN_MS,
  type SearchExit,
  waitForManagedCleanup,
} from './supervised-search';
import type { GlobRunner } from './types';

export { collectMatchedPaths } from './runner-output';
export {
  adaptSupervisedSearch,
  DEFAULT_CLEANUP_WAIT_MS,
  type ManagedSearch,
  POST_EXIT_DRAIN_MS,
} from './supervised-search';

interface SpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  killGraceMs?: number;
  postExitDrainMs?: number;
}

interface RunnerDeps {
  resolve: typeof resolveGlobCliWithAutoInstall;
  spawn: (
    cmd: string,
    args: string[],
    opts: SpawnOptions,
  ) => ChildProcess | ManagedSearch;
  killGraceMs?: number;
  postExitDrainMs?: number;
  // Final-result budget after an early stop, independent of the search timeout.
  cleanupWaitMs?: number;
}

type Done =
  | {
      type: 'close';
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    }
  | {
      type: 'error';
      error: unknown;
    };

function kill(proc: ChildProcess | undefined, signal?: NodeJS.Signals): void {
  try {
    proc?.kill(signal);
  } catch {
    // Process may have exited.
  }
}

export function createRipgrepRunner(
  deps: RunnerDeps = {
    resolve: resolveGlobCliWithAutoInstall,
    spawn: (cmd, args, options) =>
      process.platform === 'win32'
        ? nodeSpawn(cmd, args, { cwd: options.cwd, stdio: options.stdio })
        : adaptSupervisedSearch(
            spawnSupervised([cmd, ...args], {
              cwd: options.cwd,
              stdin: 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
              killGraceMs: options.killGraceMs,
            }),
            { postExitDrainMs: options.postExitDrainMs },
          ),
  },
): GlobRunner {
  return async (input, signal) => {
    const state = { timedOut: false, cancelled: false, limitReached: false };
    const controller = new AbortController();
    let proc: ChildProcess | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => undefined;
    let stopStdout: () => void = () => undefined;
    let stopStderr: () => void = () => undefined;
    let clearDone: () => void = () => undefined;
    let clearReaderErrors: () => void = () => undefined;
    let managedStop: (() => void) | undefined;
    let managedExit: (() => SearchExit | undefined) | undefined;
    let managedCompleted: Promise<SearchExit> | undefined;
    let childExited = false;
    let stopping = false;
    let stopRequestedAt: number | undefined;
    const clearKill = () => {
      clearTimeout(killTimer);
      killTimer = undefined;
    };

    if (signal.aborted) {
      const timedOut =
        signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      return emptyResult(input, buildRgCommand(input), {
        incomplete: true,
        timedOut,
        cancelled: !timedOut,
        exitCode: timedOut ? 124 : 130,
      });
    }

    const stop = () => {
      if (!proc || stopping) return;
      stopping = true;
      stopRequestedAt = performance.now();

      if (managedStop) {
        managedStop();
        return;
      }
      // Raw injected ChildProcesses have no group-ownership capability.
      // Never infer one from detached or pid, especially after exit/close.
      if (childExited) return;
      if (process.platform === 'win32') {
        kill(proc);
        return;
      }

      kill(proc, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!childExited) kill(proc, 'SIGKILL');
          clearKill();
          clearDone();
        }, deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    let finishCancel: ((value: 'cancel') => void) | undefined;
    const cancelResult = new Promise<'cancel'>((resolve) => {
      finishCancel = resolve;
    });
    let finishTimeout: ((value: 'timeout') => void) | undefined;
    const timeoutResult = new Promise<'timeout'>((resolve) => {
      finishTimeout = resolve;
    });

    const onAbort = () => {
      const timedOut =
        signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      state.timedOut ||= timedOut;
      state.cancelled ||= !timedOut;
      controller.abort();
      stop();
      if (timedOut) finishTimeout?.('timeout');
      else finishCancel?.('cancel');
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
      finishTimeout?.('timeout');
    }, input.timeoutMs);
    timeout.unref?.();

    let command = buildRgCommand(input);

    try {
      const resolved = await Promise.race([
        deps
          .resolve({}, controller.signal, {
            allowAutoInstall: input.allowAutoInstall === true,
          })
          .then((cli) => ({ type: 'cli' as const, cli }))
          .catch((error) => ({ type: 'resolve-error' as const, error })),
        cancelResult,
        timeoutResult,
      ]);

      if (resolved === 'cancel' || resolved === 'timeout') {
        return emptyResult(input, command, {
          incomplete: true,
          timedOut: state.timedOut,
          cancelled: state.cancelled,
          exitCode: state.cancelled ? 130 : 124,
        });
      }

      if (resolved.type === 'resolve-error') {
        if (
          resolved.error instanceof AbortWaitError ||
          controller.signal.aborted
        ) {
          return emptyResult(input, command, {
            incomplete: true,
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            exitCode: state.cancelled ? 130 : 124,
          });
        }

        return emptyResult(input, command, {
          exitCode: 1,
          error: toErrorMessage(resolved.error),
        });
      }

      const cli = resolved.cli;

      command = buildRgCommand(input, cli.path);
      try {
        const [cmd, ...args] = command;
        // The CLI promise can win the race before abort is delivered, while
        // this continuation is still queued. Recheck at the spawn boundary.
        if (signal.aborted || controller.signal.aborted) {
          return emptyResult(input, command, {
            incomplete: true,
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            exitCode: state.cancelled ? 130 : 124,
          });
        }
        const spawned = deps.spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: input.searchPath,
          killGraceMs: deps.killGraceMs,
          postExitDrainMs: deps.postExitDrainMs,
        });
        if ('child' in spawned) {
          proc = spawned.child;
          managedStop = spawned.stop;
          managedExit = spawned.readExit;
          // Normalize rejection before subscribing or racing: early-stop
          // winners must not orphan a rejected completion promise.
          managedCompleted = spawned.completed.catch((error) => ({
            ...(spawned.readExit() ?? { code: null, signal: null }),
            error: `Supervisor cleanup unconfirmed: ${toErrorMessage(error)}`,
          }));
        } else {
          proc = spawned;
        }
      } catch (error) {
        return emptyResult(input, command, {
          exitCode: 1,
          error: toErrorMessage(error),
        });
      }

      const child = proc;

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

      const done = new Promise<Done>((resolve) => {
        let settled = false;
        const settle = (value: Done) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const onExit = () => {
          childExited = true;
          clearKill();
        };
        const onClose = (
          code: number | null,
          closeSignal: NodeJS.Signals | null,
        ) => {
          // The sentinel owns escalation independently of the direct child.
          // Closing this child must never cause signalling a saved PGID.
          onExit();
          if (managedCompleted) return;
          clearDone();
          settle({ type: 'close', code, signal: closeSignal });
        };
        const onError = (error: unknown) => {
          if (settled) return;
          // A stream/child error must START termination, not skip it:
          // SIGTERM now, SIGKILL after the grace period.
          stop();
          if (managedCompleted) return;
          settle({ type: 'error', error });
        };

        child.once('close', onClose);
        child.once('exit', onExit);
        child.on('error', onError);
        // Stream errors (EPIPE, ECONNRESET on the pipe, ...) must funnel
        // into the same settlement; otherwise they become unhandled
        // 'error' events that crash the plugin process.
        child.stdout?.on('error', onError);
        child.stderr?.on('error', onError);
        clearReaderErrors = () => {
          child.stdout?.removeListener('error', onError);
          child.stderr?.removeListener('error', onError);
        };
        clearDone = () => {
          child.removeListener('close', onClose);
          child.removeListener('exit', onExit);
          child.removeListener('error', onError);
          clearReaderErrors();
        };
        void managedCompleted?.then((exit) => {
          clearDone();
          settle({ type: 'close', ...exit });
        });
      });

      // Also handle a synchronous abort from an injected spawn implementation.
      if (controller.signal.aborted) stop();

      const ended = await Promise.race([
        done,
        timeoutResult,
        cancelResult,
        limitResult,
      ]);
      const earlyStop =
        ended === 'timeout' || ended === 'cancel' || ended === 'limit';
      let finalExit = !earlyStop && ended.type === 'close' ? ended : undefined;
      let cleanupError: string | undefined;
      if (earlyStop && managedCompleted) {
        // Search has ended. Do not let its deadline reclassify a limit stop
        // while we wait for the independently bounded cleanup protocol.
        clearTimeout(timeout);
        removeAbort();
        const defaultBudget =
          (deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS) +
          DEFAULT_CLEANUP_TIMEOUT_MS +
          (deps.postExitDrainMs ?? POST_EXIT_DRAIN_MS);
        const requestedBudget = deps.cleanupWaitMs ?? defaultBudget;
        const budget = Number.isFinite(requestedBudget)
          ? Math.max(0, Math.min(requestedBudget, 2_147_483_647))
          : DEFAULT_CLEANUP_WAIT_MS;
        const remaining = Math.max(
          0,
          budget - (performance.now() - (stopRequestedAt ?? performance.now())),
        );
        const cleanup = await waitForManagedCleanup(
          managedCompleted,
          remaining,
        );
        if (cleanup) finalExit = { type: 'close', ...cleanup };
        else {
          cleanupError =
            'Supervisor cleanup unconfirmed: cleanup wait deadline exceeded';
        }
        clearDone();
      }
      const incomplete =
        state.timedOut ||
        state.cancelled ||
        ended === 'timeout' ||
        ended === 'cancel';
      const output = stdout.read();
      const err = stderr.read();
      const result = sliceLimit(input, output);
      if (
        ended !== 'timeout' &&
        ended !== 'cancel' &&
        ended !== 'limit' &&
        ended.type !== 'error'
      ) {
        clearDone();
      }

      const exitCode =
        ended === 'timeout'
          ? (finalExit?.code ?? managedExit?.()?.code ?? child.exitCode ?? 124)
          : ended === 'cancel'
            ? (finalExit?.code ??
              managedExit?.()?.code ??
              child.exitCode ??
              130)
            : ended === 'limit'
              ? (finalExit?.code ??
                managedExit?.()?.code ??
                child.exitCode ??
                0)
              : ended.type === 'close'
                ? (ended.code ?? 1)
                : 1;
      const interrupted =
        state.timedOut || state.cancelled || state.limitReached;
      const exitError =
        cleanupError ??
        finalExit?.error ??
        (!earlyStop && ended.type === 'error'
          ? toErrorMessage(ended.error)
          : !interrupted && finalExit?.signal
            ? `rg terminated by signal ${finalExit.signal}`
            : undefined);

      // Native parity: exit 2 with rows already collected is a partial
      // success (e.g. a permission-denied subtree), not a hard failure.
      const partialByExitCode =
        ended !== 'cancel' &&
        ended !== 'timeout' &&
        ended !== 'limit' &&
        ended.type === 'close' &&
        ended.code === 2 &&
        result.length > 0;
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
      return emptyResult(input, command, {
        exitCode: 1,
        error: toErrorMessage(error),
      });
    } finally {
      clearTimeout(timeout);
      removeAbort();
      clearReaderErrors();
      stopStdout();
      stopStderr();
      // Readers have their own error guards through destruction. Their run
      // listeners are not needed while background termination finishes.
      // Child listeners remain until close or the bounded escalation timer.
    }
  };
}

export const runRipgrep = createRipgrepRunner();

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { AbortWaitError, resolveGlobCliWithAutoInstall } from './resolver';
import { buildRgCommand } from './rg-args';
import type {
  GlobRunner,
  GlobSearchResult,
  NormalizedGlobInput,
} from './types';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KILL_GRACE_MS = 5_000;

function createMatcher(pattern: string): (file: string) => boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const hasPathSegment = normalizedPattern.includes('/');
  const isLiteral = !/[?*[{]/.test(normalizedPattern);
  const basenameSuffix =
    !hasPathSegment && normalizedPattern.startsWith('*.')
      ? normalizedPattern.slice(1)
      : null;
  const deepSuffix = normalizedPattern.startsWith('**/*.')
    ? normalizedPattern.slice(4)
    : null;

  if (normalizedPattern === '**/*') {
    return () => true;
  }

  if (deepSuffix) {
    return (file) => file.replace(/\\/g, '/').endsWith(deepSuffix);
  }

  if (basenameSuffix) {
    return (file) =>
      path.basename(file.replace(/\\/g, '/')).endsWith(basenameSuffix);
  }

  if (isLiteral) {
    if (hasPathSegment) {
      return (file) => file.replace(/\\/g, '/') === normalizedPattern;
    }

    return (file) =>
      path.basename(file.replace(/\\/g, '/')) === normalizedPattern;
  }

  return (file) => {
    const normalized = file.replace(/\\/g, '/');
    if (path.matchesGlob(normalized, normalizedPattern)) return true;
    if (hasPathSegment) return false;
    return path.matchesGlob(path.basename(normalized), normalizedPattern);
  };
}

export function parseNulPaths(
  input: Pick<NormalizedGlobInput, 'searchPath'>,
  stdout: string,
  options: { discardIncomplete?: boolean } = {},
): string[] {
  if (stdout.length === 0) return [];

  const parts = stdout.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  if (options.discardIncomplete && !stdout.endsWith('\0')) parts.pop();

  return parts
    .filter((file) => file.length > 0)
    .map((file) => path.resolve(input.searchPath, file));
}

function sliceLimit(input: NormalizedGlobInput, files: string[]): string[] {
  return files.slice(0, input.limit);
}

function emptyResult(
  input: NormalizedGlobInput,
  command: string[] | undefined,
  extra: Partial<GlobSearchResult> = {},
): GlobSearchResult {
  return {
    files: [],
    count: 0,
    backend: 'rg',
    truncated: false,
    incomplete: false,
    timedOut: false,
    cancelled: false,
    exitCode: 0,
    command,
    cwd: input.searchPath,
    stderr: '',
    ...extra,
  };
}

interface RunnerDeps {
  resolve: typeof resolveGlobCliWithAutoInstall;
  spawn: (
    cmd: string,
    args: string[],
    opts: {
      cwd: string;
      stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => ChildProcess;
  killGraceMs?: number;
}

type Done =
  | {
      type: 'close';
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: 'error';
      error: unknown;
    };

function watch(stream: NodeJS.ReadableStream | null): {
  read: () => string;
  stop: () => void;
} {
  if (!stream) {
    return {
      read: () => '',
      stop: () => undefined,
    };
  }

  const chunks: string[] = [];
  const onData = (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
  };

  stream.on('data', onData);

  return {
    read: () => chunks.join(''),
    stop: () => {
      stream.removeListener('data', onData);
    },
  };
}

function kill(proc: ChildProcess | undefined, signal?: NodeJS.Signals): void {
  try {
    proc?.kill(signal);
  } catch {
    // Process may have exited.
  }
}

function collectMatchedPaths(
  input: NormalizedGlobInput,
  stream: NodeJS.ReadableStream | null,
  matchesPattern: (file: string) => boolean,
  options: { onOverflow?: () => void } = {},
): {
  read: (options?: { discardIncomplete?: boolean }) => string[];
  stop: () => void;
} {
  if (!stream) {
    return {
      read: () => [],
      stop: () => undefined,
    };
  }

  const files: string[] = [];
  let remainder = '';
  let overflowed = false;
  const onData = (chunk: Buffer | string) => {
    if (overflowed) return;

    const data =
      remainder + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    const parts = data.split('\0');
    remainder = parts.pop() ?? '';

    for (const file of parts) {
      if (file.length === 0) continue;
      const absolute = path.resolve(input.searchPath, file);
      if (matchesPattern(path.relative(input.searchPath, absolute))) {
        files.push(absolute);
        if (files.length > input.limit) {
          overflowed = true;
          options.onOverflow?.();
          break;
        }
      }
    }
  };

  stream.on('data', onData);

  return {
    read: (options = {}) => {
      const current = [...files];
      if (!options.discardIncomplete && remainder.length > 0) {
        const absolute = path.resolve(input.searchPath, remainder);
        if (matchesPattern(path.relative(input.searchPath, absolute))) {
          current.push(absolute);
        }
      }
      return current;
    },
    stop: () => {
      stream.removeListener('data', onData);
    },
  };
}

export function createRipgrepRunner(
  deps: RunnerDeps = {
    resolve: resolveGlobCliWithAutoInstall,
    spawn: nodeSpawn,
  },
): GlobRunner {
  return async (input, signal) => {
    const preview = buildRgCommand(input);
    const state = { timedOut: false, cancelled: false, limitReached: false };
    const matchesPattern = createMatcher(input.relativePattern);
    const controller = new AbortController();
    let proc: ChildProcess | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = () => undefined;
    let keepDoneListeners = false;

    if (signal.aborted) {
      return emptyResult(input, preview, {
        incomplete: true,
        cancelled: true,
        exitCode: 130,
      });
    }

    const stop = () => {
      if (!proc) return;

      if (process.platform === 'win32') {
        kill(proc);
        return;
      }

      kill(proc, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(
          () => kill(proc, 'SIGKILL'),
          deps.killGraceMs ?? KILL_GRACE_MS,
        );
        killTimer.unref?.();
      }
    };

    let finishCancel: ((value: 'cancel') => void) | undefined;
    const cancelResult = new Promise<'cancel'>((resolve) => {
      finishCancel = resolve;
    });
    const onAbort = () => {
      state.cancelled = true;
      controller.abort();
      stop();
      finishCancel?.('cancel');
    };

    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => {
      signal.removeEventListener('abort', onAbort);
    };

    let command = preview;

    try {
      const resolved = await Promise.race([
        deps
          .resolve({}, controller.signal)
          .then((cli) => ({ type: 'cli' as const, cli }))
          .catch((error) => ({ type: 'resolve-error' as const, error })),
        cancelResult,
      ]);

      if (resolved === 'cancel') {
        return emptyResult(input, preview, {
          incomplete: true,
          cancelled: state.cancelled,
          exitCode: 130,
        });
      }

      if (resolved.type === 'resolve-error') {
        if (
          resolved.error instanceof AbortWaitError ||
          controller.signal.aborted
        ) {
          return emptyResult(input, preview, {
            incomplete: true,
            timedOut: state.timedOut,
            cancelled: state.cancelled,
            exitCode: state.cancelled ? 130 : 0,
          });
        }

        return emptyResult(input, preview, {
          exitCode: 1,
          error: toErrorMessage(resolved.error),
        });
      }

      const cli = resolved.cli;

      command = buildRgCommand(input, cli.path);
      try {
        const [cmd, ...args] = command;
        proc = deps.spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: input.searchPath,
        });
      } catch (error) {
        return emptyResult(input, command, {
          exitCode: 1,
          error: toErrorMessage(error),
        });
      }

      const child = proc;

      let finishTimeout: ((value: 'timeout') => void) | undefined;
      const timeoutResult = new Promise<'timeout'>((resolve) => {
        finishTimeout = resolve;
      });
      timeout = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
        stop();
        finishTimeout?.('timeout');
      }, input.timeoutMs);

      let finishLimit: ((value: 'limit') => void) | undefined;
      const limitResult = new Promise<'limit'>((resolve) => {
        finishLimit = resolve;
      });

      const stdout = collectMatchedPaths(input, child.stdout, matchesPattern, {
        onOverflow: () => {
          if (state.limitReached) return;
          state.limitReached = true;
          stop();
          finishLimit?.('limit');
        },
      });
      const stderr = watch(child.stderr);

      let clearDone = () => undefined;
      const done = new Promise<Done>((resolve) => {
        const onClose = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          clearTimeout(killTimer);
          resolve({ type: 'close', code, signal });
        };
        const onError = (error: unknown) => {
          clearTimeout(killTimer);
          resolve({ type: 'error', error });
        };

        child.once('close', onClose);
        child.once('error', onError);
        clearDone = () => {
          child.removeListener('close', onClose);
          child.removeListener('error', onError);
        };
      });

      const ended = await Promise.race([
        done,
        timeoutResult,
        cancelResult,
        limitResult,
      ]);
      const incomplete =
        state.timedOut ||
        state.cancelled ||
        ended === 'timeout' ||
        ended === 'cancel';
      keepDoneListeners =
        ended === 'timeout' || ended === 'cancel' || ended === 'limit';
      const output = stdout.read({
        discardIncomplete: incomplete || ended === 'limit',
      });
      const err = stderr.read();
      const result = sliceLimit(input, output);
      stdout.stop();
      stderr.stop();
      if (!keepDoneListeners) clearDone();

      const exitCode =
        ended === 'timeout'
          ? (child.exitCode ?? 124)
          : ended === 'cancel'
            ? (child.exitCode ?? 130)
            : ended === 'limit'
              ? (child.exitCode ?? 0)
              : ended.type === 'close'
                ? (ended.code ?? 1)
                : 1;
      const exitError =
        ended !== 'timeout' &&
        ended !== 'cancel' &&
        ended !== 'limit' &&
        ended.type === 'error'
          ? toErrorMessage(ended.error)
          : undefined;
      const failed =
        !state.timedOut &&
        !state.cancelled &&
        !state.limitReached &&
        (Boolean(exitError) || (exitCode !== 0 && exitCode !== 1));

      return {
        files: result,
        count: result.length,
        backend: 'rg',
        truncated: state.limitReached || output.length > input.limit,
        incomplete,
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
    }
  };
}

export const runRipgrep = createRipgrepRunner();

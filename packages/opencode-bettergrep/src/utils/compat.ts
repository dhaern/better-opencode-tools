import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { readTextStream } from '../tools/grep/json-stream';

export interface CrossSpawnResult {
  proc: ChildProcess;
  /** Collects all stdout into a string */
  stdout: () => Promise<string>;
  /** Collects all stderr into a string */
  stderr: () => Promise<string>;
  /** Resolves when process exits with exit code */
  exited: Promise<number>;
  /** Kill the process */
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Current exit code or null if running */
  get exitCode(): number | null;
}

const MAX_COLLECTED_OUTPUT_CHARS = 1_000_000;
const TERMINATE_GRACE_MS = 500;
export const TERMINATE_HARD_WAIT_MS = 1_500;
const TERMINATIONS = new WeakMap<CrossSpawnResult, Promise<void>>();

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    const finish = (value: T | 'timeout') => {
      clearTimeout(timer);
      resolve(value);
    };
    void promise.then(finish, () => finish('timeout'));
  });
}

export function hasProcessExited(proc: CrossSpawnResult): boolean {
  return proc.exitCode !== null || proc.proc.signalCode != null;
}

function sendSignal(proc: CrossSpawnResult, signal?: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {
    /* process already exited */
  }
}

/**
 * Terminate a spawned process with escalation: SIGTERM, then SIGKILL after a
 * grace period, with a hard bound on how long we wait overall. Probes must
 * never hang on a child that ignores SIGTERM.
 */
export function terminateProcess(proc: CrossSpawnResult): Promise<void> {
  const existing = TERMINATIONS.get(proc);
  if (existing) return existing;
  if (hasProcessExited(proc)) return Promise.resolve();

  const pending = (async () => {
    sendSignal(proc);
    if ((await withTimeout(proc.exited, TERMINATE_GRACE_MS)) !== 'timeout')
      return;
    if (hasProcessExited(proc)) return;
    sendSignal(proc, 'SIGKILL');
    await withTimeout(proc.exited, TERMINATE_HARD_WAIT_MS);
  })();
  TERMINATIONS.set(proc, pending);
  return pending;
}

/**
 * Waits for process output with an abort-gated cleanup grace. The grace
 * (termination + bounded pipe drain) applies only after a REAL abort; a
 * healthy but slow operation has no implicit duration cap. Returns
 * 'aborted' when the signal fired, or the output value otherwise.
 */
export async function waitForProcessOutputWithAbortGrace<T>(
  proc: CrossSpawnResult,
  outputWait: Promise<T>,
  signal?: AbortSignal,
): Promise<T | 'aborted'> {
  if (!signal) {
    return outputWait;
  }

  let resolveTerminated!: () => void;
  let terminationStarted = false;
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve;
  });
  const onAbort = () => {
    if (terminationStarted) return;
    terminationStarted = true;
    void terminateProcess(proc).finally(resolveTerminated);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const raced = await Promise.race([
      outputWait.then(
        (value) => ({ kind: 'output' as const, value }),
        (error) => ({ kind: 'error' as const, error }),
      ),
      terminated.then(() => ({ kind: 'aborted' as const })),
    ]);

    if (raced.kind === 'output') {
      return raced.value;
    }
    if (raced.kind === 'error') {
      throw raced.error;
    }

    // Post-termination drain bound: descendants inheriting the pipes can keep
    // the output wait pending; force-close the pipes when the deadline hits.
    if ((await withTimeout(outputWait, TERMINATE_HARD_WAIT_MS)) === 'timeout') {
      proc.proc.stdout?.destroy();
      proc.proc.stderr?.destroy();
    }
    return 'aborted';
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function collectStream(
  stream: NodeJS.ReadableStream | null,
  maxChars = MAX_COLLECTED_OUTPUT_CHARS,
): () => Promise<string> {
  let collected: Promise<string> | undefined;
  return () => {
    // Node buffers the paused stream until its first collector call.
    if (!collected) {
      collected = readTextStream(
        stream,
        maxChars,
        '[process output truncated]',
        false,
        false,
      );
      void collected.catch(() => undefined);
    }
    return collected;
  };
}

/**
 * Cross-runtime spawn that works in both Bun and Node.js.
 * API mimics Bun.spawn but uses node:child_process internally.
 */
export function crossSpawn(
  command: string[],
  options?: {
    stdout?: 'pipe' | 'inherit' | 'ignore';
    stderr?: 'pipe' | 'inherit' | 'ignore';
    stdin?: 'pipe' | 'inherit' | 'ignore';
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): CrossSpawnResult {
  const [cmd, ...args] = command;
  const proc = nodeSpawn(cmd, args, {
    stdio: [
      options?.stdin ?? 'ignore',
      options?.stdout ?? 'pipe',
      options?.stderr ?? 'pipe',
    ],
    cwd: options?.cwd,
    env: options?.env as NodeJS.ProcessEnv,
  });

  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);

  const exited = new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });
  // A spawn failure can reject this promise before any consumer attaches a
  // handler, which Node reports as an unhandled rejection. Keep a no-op
  // handler attached from creation; later consumers still observe the
  // rejection through the original promise.
  void exited.catch(() => undefined);

  return {
    proc,
    stdout: stdoutCollector,
    stderr: stderrCollector,
    exited,
    kill: (signal) => proc.kill(signal as NodeJS.Signals),
    get exitCode() {
      return proc.exitCode;
    },
  };
}

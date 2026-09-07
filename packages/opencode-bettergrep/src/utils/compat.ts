import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';

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

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve('timeout');
      },
    );
  });
}

/**
 * Terminate a spawned process with escalation: SIGTERM, then SIGKILL after a
 * grace period, with a hard bound on how long we wait overall. Probes must
 * never hang on a child that ignores SIGTERM.
 */
export async function terminateProcess(proc: CrossSpawnResult): Promise<void> {
  if (proc.exitCode !== null) return;

  try {
    proc.kill();
  } catch {
    // Process may have already exited.
  }

  if ((await withTimeout(proc.exited, TERMINATE_GRACE_MS)) !== 'timeout') {
    return;
  }

  try {
    proc.kill('SIGKILL');
  } catch {
    // Process may have already exited.
  }

  await withTimeout(proc.exited, TERMINATE_HARD_WAIT_MS);
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
  if (!stream) return () => Promise.resolve('');
  let collected: Promise<string> | undefined;

  return () => {
    if (collected) return collected;

    collected = new Promise<string>((resolve, reject) => {
      let text = '';
      let settled = false;

      const cleanup = () => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('close', onClose);
        stream.removeListener('error', onError);
      };
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onData = (chunk: Buffer | string | Uint8Array) => {
        const next =
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8');
        const remaining = maxChars - text.length;
        if (next.length > remaining) {
          text += next.slice(0, Math.max(0, remaining));
          finish(`${text}\n[process output truncated]`);
          // Keep draining the pipe without retaining the rest in memory.
          stream.removeListener('data', onData);
          stream.resume?.();
          return;
        }
        text += next;
      };
      const onEnd = () => finish(text);
      const onClose = () => finish(text);
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('close', onClose);
      stream.on('error', onError);
    });

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

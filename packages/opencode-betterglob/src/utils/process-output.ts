import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import which from 'which';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  isSupervisorError,
  type SupervisedProcess,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';

export const ABORT_KILL_GRACE_MS = 5_000;
export const POST_EXIT_DRAIN_MS = 1_000;
export const DIAGNOSTIC_CAP_BYTES = 8 * 1024;

export const capText = (
  chunks: Buffer[],
  truncated: boolean,
  label: 'stdout' | 'stderr',
): string =>
  Buffer.concat(chunks).toString('utf-8') +
  (truncated ? `\n[${label} truncated at ${DIAGNOSTIC_CAP_BYTES} bytes]` : '');

export interface ProcessHandle {
  proc: ChildProcess;
  exited: Promise<number>;
  closed?: Promise<void>;
  stop?: (graceMs?: number) => Promise<void>;
  release?: () => Promise<void>;
  readonly exitCode: number | null;
}

export interface ProcessOptions {
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  stdin?: 'pipe' | 'inherit' | 'ignore';
  cwd?: string;
  env?: Record<string, string | undefined>;
  killProcessGroup?: boolean;
  killGraceMs?: number;
  postCloseDrainMs?: number;
  cleanupTimeoutMs?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

export function waitForProcessOutputWithAbortGrace(
  proc: ProcessHandle,
  signal?: AbortSignal,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline = Infinity;
    let finished = false;
    let processExited = false;
    let processError: unknown;
    let outputError: unknown;
    let stdoutText = '';
    let stderrError: unknown;
    let stderrText = '';
    let stdoutSettled = false;
    let stderrSettled = false;
    let aborted = signal?.aborted === true;
    let exitCode = 1;
    let cleanupSettled = !proc.closed;
    let releaseRequested = false;
    let terminating = false;

    const cleanup = () => {
      clearTimeout(cleanupTimer);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      proc.proc.removeListener('close', onClose);
      proc.proc.removeListener('exit', onExit);
      proc.proc.removeListener('error', onProcessError);
    };

    const cleanupFailed = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      closeReaders();
      reject(
        processError instanceof SupervisorRuntimeError
          ? processError
          : isSupervisorError(error)
            ? error
            : new CleanupUnconfirmedError(
                error instanceof Error ? error.message : String(error),
              ),
      );
    };

    const watchCleanup = (grace: number) => {
      if (cleanupSettled) return;
      const timeout = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
      const wait = Math.max(0, Math.min(grace + timeout, 2_147_483_647));
      const deadline = performance.now() + wait;
      if (deadline >= cleanupDeadline) return;
      cleanupDeadline = deadline;
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(
        () =>
          cleanupFailed(new CleanupUnconfirmedError('parent watchdog expired')),
        wait,
      );
    };

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      if (proc.stop) {
        // The supervisor owns the grace timer even after task exit.
        const grace = options.killGraceMs ?? ABORT_KILL_GRACE_MS;
        watchCleanup(grace);
        void proc.stop(grace).catch(cleanupFailed);
        return;
      }
      try {
        proc.proc.kill('SIGTERM');
      } catch {
        // Process may have exited.
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            proc.proc.kill('SIGKILL');
          } catch {
            // Process may have exited.
          } finally {
            // Descendants can keep pipes open after SIGKILL; close readers.
            if (!finished) {
              processExited = true;
              exitCode = proc.exitCode ?? 1;
              closeReaders();
            }
          }
        }, options.killGraceMs ?? ABORT_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const finish = () => {
      if (finished || !processExited || !stdoutSettled || !stderrSettled)
        return;
      if (!cleanupSettled) {
        if (!terminating && !releaseRequested) {
          releaseRequested = true;
          watchCleanup(0);
          void proc.release?.().catch(cleanupFailed);
        }
        return;
      }
      finished = true;
      cleanup();

      const failure = processError || outputError || stderrError;
      if (failure)
        reject(failure instanceof Error ? failure : new Error(String(failure)));
      else
        resolve({ exitCode, stdout: stdoutText, stderr: stderrText, aborted });
    };

    const closeReaders = () => {
      for (const stream of [proc.proc.stdout, proc.proc.stderr]) {
        if (!stream || stream.destroyed) continue;
        const ignore = () => undefined;
        stream.on('error', ignore);
        stream.once('close', () => stream.removeListener('error', ignore));
        stream.destroy();
      }
      finish();
    };

    const scheduleDrain = () => {
      if ((stdoutSettled && stderrSettled) || drainTimer) return;
      drainTimer = setTimeout(() => {
        if (finished) return;
        // Hold the group leader while inherited output can still be open.
        if (proc.stop) terminate();
        closeReaders();
      }, options.postCloseDrainMs ?? POST_EXIT_DRAIN_MS);
      drainTimer.unref?.();
    };

    const onExit = (code: number | null) => {
      processExited = true;
      exitCode = code ?? proc.exitCode ?? 1;
      // A descendant may still retain a pipe after task exit.
      scheduleDrain();
      finish();
    };

    const onClose = (code: number | null) => {
      processExited = true;
      exitCode = code ?? proc.exitCode ?? 1;
      clearTimeout(killTimer);
      scheduleDrain();
      finish();
    };

    const onProcessError = (error: unknown) => {
      if (finished || processExited) return;
      processError = error;
      // Spawn error precedes close, which remains authoritative.
      terminate();
      if (proc.closed) {
        processExited = true;
        scheduleDrain();
        finish();
      }
    };

    const capture = (
      stream: ChildProcess['stdout'],
      label: 'stdout' | 'stderr',
    ) => {
      const chunks: Buffer[] = [];
      let retained = 0;
      let truncated = false;
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        stream?.removeListener('data', onData);
        stream?.removeListener('end', onEnd);
        stream?.removeListener('close', onEnd);
        stream?.removeListener('error', settle);
        if (label === 'stdout') {
          stdoutSettled = true;
          stdoutText = capText(chunks, truncated, label);
          if (error !== undefined) outputError = error;
        } else {
          stderrSettled = true;
          stderrText = capText(chunks, truncated, label);
          if (error !== undefined) stderrError = error;
        }
        if (error !== undefined) terminate();
        finish();
      };
      const onData = (value: Buffer | string) => {
        const chunk = typeof value === 'string' ? Buffer.from(value) : value;
        if (retained >= DIAGNOSTIC_CAP_BYTES) {
          truncated = true;
          return;
        }
        const available = DIAGNOSTIC_CAP_BYTES - retained;
        chunks.push(chunk.subarray(0, available));
        retained += Math.min(available, chunk.length);
        if (chunk.length > available) truncated = true;
      };
      const onEnd = () => settle();
      stream?.on('data', onData);
      stream?.once('end', onEnd);
      stream?.once('close', onEnd);
      stream?.on('error', settle);
      if (!stream?.readable) settle();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
      finish();
    };

    // Close confirms direct children; exited observes task/supervisor status.
    if (!proc.closed) {
      proc.proc.once('close', onClose);
      proc.proc.once('exit', onExit);
    }
    proc.proc.once('error', onProcessError);
    void proc.exited.then(onExit, onProcessError);
    void proc.closed?.then(() => {
      cleanupSettled = true;
      clearTimeout(cleanupTimer);
      // Task exit and bounded output drain still govern settlement.
      scheduleDrain();
      finish();
    }, cleanupFailed);

    // Observe both output streams immediately.
    capture(proc.proc.stdout, 'stdout');
    capture(proc.proc.stderr, 'stderr');

    if (signal?.aborted) terminate();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function runProcess(
  command: string[],
  options: ProcessOptions = {},
  signal?: AbortSignal,
  supervise: typeof spawnSupervised = spawnSupervised,
): Promise<ProcessResult> {
  const [cmd, ...args] = command;
  const owner: SupervisedProcess | undefined =
    process.platform === 'win32' || options.killProcessGroup === false
      ? undefined
      : supervise(command, options);
  const child =
    owner?.proc ??
    nodeSpawn(cmd, args, {
      stdio: [
        options.stdin ?? 'ignore',
        options.stdout ?? 'pipe',
        options.stderr ?? 'pipe',
      ],
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
    });
  const exited = owner
    ? owner.exited.then((result) => result.code)
    : new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
  void exited.catch(() => undefined);
  return waitForProcessOutputWithAbortGrace(
    {
      proc: child,
      exited,
      closed: owner?.closed,
      stop: owner?.stop,
      release: owner?.release,
      get exitCode() {
        return owner ? owner.exitCode : child.exitCode;
      },
    },
    signal,
    options,
  );
}

export function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
  );
}

const runtimeProbes = new Set<string>();
export async function ensureSupervisorRuntime(
  signal?: AbortSignal,
  executable = 'node',
): Promise<void> {
  if (process.platform === 'win32' || !process.versions.bun) return;
  signal?.throwIfAborted();
  const { fileStamp } = await import('../tools/glob/install-io');
  const found = await which(executable, { nothrow: true }).catch(
    () => undefined,
  );
  const stamp = found ? await fileStamp(found) : undefined;
  const key = stamp
    ? `${process.env.PATH ?? ''}:${executable}:${found}:${stamp}`
    : undefined;
  signal?.throwIfAborted();
  if (key && runtimeProbes.has(key)) return;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), DEFAULT_CLEANUP_TIMEOUT_MS);
  const probeSignal = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  try {
    const result = await runProcess(
      [
        executable,
        '--input-type=commonjs',
        '--eval',
        'if (!process.versions.node || process.versions.bun) process.exit(1); process.stdout.write("betterglob-node-supervisor")',
      ],
      { killProcessGroup: false, killGraceMs: 250, postCloseDrainMs: 250 },
      probeSignal,
    );
    signal?.throwIfAborted();
    if (
      result.aborted ||
      result.exitCode !== 0 ||
      result.stdout !== 'betterglob-node-supervisor'
    )
      throw new SupervisorRuntimeError();
    if (key) runtimeProbes.add(key);
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    signal?.throwIfAborted();
    throw new SupervisorRuntimeError({ cause: error });
  } finally {
    clearTimeout(timer);
  }
}

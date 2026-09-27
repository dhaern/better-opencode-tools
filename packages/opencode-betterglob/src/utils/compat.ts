import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import which from 'which';
import {
  ABORT_KILL_GRACE_MS,
  capText,
  DIAGNOSTIC_CAP_BYTES,
  POST_EXIT_DRAIN_MS,
  waitForProcessOutputWithAbortGrace,
} from './process-output';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  isSupervisorError,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';

export { waitForProcessOutputWithAbortGrace } from './process-output';

/** Follow symlinks so replacing the target invalidates every positive memo. */
export async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return undefined;
  }
}

export function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export interface CrossSpawnResult {
  proc: ChildProcess;
  stdout: () => Promise<string>;
  stderr: () => Promise<string>;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  /** Present on supervised POSIX tasks; rejects if cleanup is unconfirmed. */
  closed?: Promise<void>;
  stop?: (graceMs?: number) => Promise<void>;
  release?: () => Promise<void>;
  get exitCode(): number | null;
}

function collectStream(
  stream: NodeJS.ReadableStream | null,
  label: 'stdout' | 'stderr',
): () => Promise<string> {
  if (!stream) return () => Promise.resolve('');
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  const onData = (value: Buffer | string) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    if (retained >= DIAGNOSTIC_CAP_BYTES) {
      truncated = true;
      return;
    }
    if (retained + chunk.length > DIAGNOSTIC_CAP_BYTES) {
      chunks.push(chunk.subarray(0, DIAGNOSTIC_CAP_BYTES - retained));
      retained = DIAGNOSTIC_CAP_BYTES;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    retained += chunk.length;
  };
  // Observe data AND errors at construction, not when stdout()/stderr() is
  // eventually called. Keep one stable, already-observed promise per stream.
  const collected = new Promise<string>((resolve, reject) => {
    const finish = () => {
      stream.removeListener('data', onData);
      resolve(capText(chunks, truncated, label));
    };
    stream.on('error', reject);
    stream.once('end', finish);
    stream.once('close', finish);
    stream.on('data', onData);
    if (!stream.readable) {
      finish();
    }
  });
  void collected.catch(() => undefined);
  return () => collected;
}

export function crossSpawn(
  command: string[],
  options?: {
    stdout?: 'pipe' | 'inherit' | 'ignore';
    stderr?: 'pipe' | 'inherit' | 'ignore';
    stdin?: 'pipe' | 'inherit' | 'ignore';
    cwd?: string;
    env?: Record<string, string | undefined>;
    killProcessGroup?: boolean;
    killGraceMs?: number;
    cleanupTimeoutMs?: number;
    postExitDrainMs?: number;
  },
): CrossSpawnResult {
  const [cmd, ...args] = command;
  const supervised =
    process.platform === 'win32' || options?.killProcessGroup === false
      ? undefined
      : spawnSupervised(command, options);
  const proc =
    supervised?.proc ??
    nodeSpawn(cmd, args, {
      stdio: [
        options?.stdin ?? 'ignore',
        options?.stdout ?? 'pipe',
        options?.stderr ?? 'pipe',
      ],
      cwd: options?.cwd,
      env: options?.env as NodeJS.ProcessEnv,
    });

  const stdoutCollector = collectStream(proc.stdout, 'stdout');
  const stderrCollector = collectStream(proc.stderr, 'stderr');

  const exited = supervised
    ? supervised.exited.then((result) => result.code)
    : new Promise<number>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('exit', (code) => resolve(code ?? 1));
      });
  void exited.catch(() => undefined);

  // Standalone callers also get bounded drain and automatic normal release.
  // A timed-out pipe indicates surviving descendants: stop, not release.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drained = false;
  let taskDone = false;
  let directKillTimer: ReturnType<typeof setTimeout> | undefined;
  proc.once('exit', () => clearTimeout(directKillTimer));
  const stop = () => {
    if (supervised) {
      void supervised.stop(options?.killGraceMs);
    } else if (
      proc.pid !== undefined &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      try {
        proc.kill('SIGTERM');
        directKillTimer ??= setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Windows: direct ChildProcess only, never a process group.
          }
        }, options?.killGraceMs ?? ABORT_KILL_GRACE_MS);
        directKillTimer.unref?.();
      } catch {
        // A direct child can disappear before the termination request.
      }
    }
  };
  const drain = () => {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };
  void Promise.all([stdoutCollector(), stderrCollector()]).then(
    () => {
      drained = true;
      clearTimeout(drainTimer);
      if (taskDone) void supervised?.release();
    },
    () => {
      clearTimeout(drainTimer);
      stop();
      drain();
    },
  );
  void exited.then(
    () => {
      taskDone = true;
      if (drained) {
        void supervised?.release();
        return;
      }
      drainTimer = setTimeout(() => {
        stop();
        drain();
      }, options?.postExitDrainMs ?? POST_EXIT_DRAIN_MS);
      drainTimer.unref?.();
    },
    () => {
      stop();
      drain();
    },
  );

  return {
    proc,
    stdout: stdoutCollector,
    stderr: stderrCollector,
    exited,
    closed: supervised?.closed,
    stop: supervised?.stop,
    release: supervised?.release,
    kill: supervised
      ? () => false
      : (signal) => proc.kill(signal as NodeJS.Signals),
    get exitCode() {
      return supervised ? supervised.exitCode : proc.exitCode;
    },
  };
}

const runtimeProbes = new Set<string>();

/** Probe Node directly before rg lookup; memoize only stamped positives. */
export async function ensureSupervisorRuntime(
  signal?: AbortSignal,
  executable = 'node',
): Promise<void> {
  if (process.platform === 'win32' || !process.versions.bun) return;
  signal?.throwIfAborted();
  const found = await which(executable, { nothrow: true }).catch(
    () => undefined,
  );
  const stamp = found && (await fileStamp(found));
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
    const probe = crossSpawn(
      [
        executable,
        '--input-type=commonjs',
        '--eval',
        'if (!process.versions.node || process.versions.bun) process.exit(1); process.stdout.write("betterglob-node-supervisor")',
      ],
      { killProcessGroup: false, stdout: 'pipe', stderr: 'pipe' },
    );
    const result = await waitForProcessOutputWithAbortGrace(
      probe,
      probe.stderr(),
      probeSignal,
      probe.stdout(),
      { killGraceMs: 250, postCloseDrainMs: 250 },
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

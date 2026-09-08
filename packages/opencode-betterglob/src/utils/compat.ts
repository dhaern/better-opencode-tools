import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  ABORT_KILL_GRACE_MS,
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

// Diagnostic cap mirroring the native adapter. Streams keep draining past
// the cap so a chatty child never blocks on a full pipe.
const COLLECT_CAP_BYTES = 8 * 1024;

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
    if (retained >= COLLECT_CAP_BYTES) {
      truncated = true;
      return;
    }
    if (retained + chunk.length > COLLECT_CAP_BYTES) {
      chunks.push(chunk.subarray(0, COLLECT_CAP_BYTES - retained));
      retained = COLLECT_CAP_BYTES;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    retained += chunk.length;
  };
  // Observe data AND errors at construction, not when stdout()/stderr() is
  // eventually called. Keep one stable, already-observed promise per stream.
  const collected = new Promise<string>((resolve, reject) => {
    const text = () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      return truncated ? `${body}\n[${label} truncated at 8192 bytes]` : body;
    };
    const finish = () => {
      stream.removeListener('data', onData);
      resolve(text());
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
    detached?: boolean;
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
      detached: options?.detached,
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
    kill: supervised?.kill ?? ((signal) => proc.kill(signal as NodeJS.Signals)),
    get exitCode() {
      return supervised ? supervised.exitCode : proc.exitCode;
    },
  };
}

/** Probe the auxiliary runtime before any rg lookup, probe or installation.
 * Direct spawn is intentional: validating Node must not itself require the
 * supervisor. No synchronous PATH/filesystem operations or persistent cache.
 */
export async function ensureSupervisorRuntime(
  signal?: AbortSignal,
  executable = 'node',
): Promise<void> {
  if (process.platform === 'win32' || !process.versions.bun) return;
  signal?.throwIfAborted();
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
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    signal?.throwIfAborted();
    throw new SupervisorRuntimeError({ cause: error });
  } finally {
    clearTimeout(timer);
  }
}

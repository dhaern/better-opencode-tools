import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  isSupervisorError,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';

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

// Waits for a helper process after termination. There is no implicit
// deadline for healthy runs: the grace window that escalates SIGTERM to
// SIGKILL starts only on abort, failure or expired post-task drain, so long
// legitimate extractions are never aborted early.
const ABORT_KILL_GRACE_MS = 5_000;
const POST_EXIT_DRAIN_MS = 1_000;

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

export function waitForProcessOutputWithAbortGrace(
  proc: CrossSpawnResult,
  stderrPromise: Promise<string>,
  signal?: AbortSignal,
  stdoutPromise: Promise<string> = proc.stdout(),
  options: {
    killGraceMs?: number;
    postCloseDrainMs?: number;
    /** Parent-side allowance after killGraceMs; never sends PID/PGID signals. */
    cleanupTimeoutMs?: number;
  } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
}> {
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

    const stopKillTimer = () => {
      clearTimeout(killTimer);
      killTimer = undefined;
    };

    const cleanup = () => {
      clearTimeout(cleanupTimer);
      clearTimeout(drainTimer);
      drainTimer = undefined;
      stopKillTimer();
      signal?.removeEventListener('abort', onAbort);
      proc.proc.removeListener('close', onClose);
      proc.proc.removeListener('exit', onExit);
      proc.proc.removeListener('error', onProcessError);
    };

    const cleanupFailed = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      proc.proc.stdout?.destroy();
      proc.proc.stderr?.destroy();
      if (processError instanceof SupervisorRuntimeError) {
        reject(processError);
        return;
      }
      reject(
        isSupervisorError(error)
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
        // The supervisor owns both TERM and the full grace timer. Task exit
        // or closed output must not cancel cleanup of remaining descendants.
        const grace = options.killGraceMs ?? ABORT_KILL_GRACE_MS;
        watchCleanup(grace);
        void proc.stop(grace).catch(cleanupFailed);
        return;
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have exited.
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process may have exited.
          } finally {
            // A descendant can keep an inherited pipe open after the child
            // receives SIGKILL, preventing Node's `close` event from being
            // delivered. Destroy the readers and settle the aborted wait so
            // the caller cannot remain blocked on that orphaned descriptor.
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

      if (processError) {
        reject(
          processError instanceof Error
            ? processError
            : new Error(String(processError)),
        );
        return;
      }

      if (outputError) {
        reject(
          outputError instanceof Error
            ? outputError
            : new Error(String(outputError)),
        );
        return;
      }

      if (stderrError) {
        reject(
          stderrError instanceof Error
            ? stderrError
            : new Error(String(stderrError)),
        );
        return;
      }

      resolve({ exitCode, stdout: stdoutText, stderr: stderrText, aborted });
    };

    const closeReaders = () => {
      proc.proc.stdout?.destroy();
      proc.proc.stderr?.destroy();
      // Let close/error observers settle collectors with their retained bytes
      // before the fallback for arbitrary non-settling consumer promises.
      setImmediate(() => {
        stdoutSettled = true;
        stderrSettled = true;
        finish();
      });
    };

    const scheduleDrain = () => {
      if ((stdoutSettled && stderrSettled) || drainTimer) return;
      drainTimer = setTimeout(() => {
        if (finished) return;
        // EOF may be held by a descendant after taskExit. Preserve the group
        // leader until cleanup completes, rather than releasing its identity.
        if (proc.stop) terminate();
        closeReaders();
      }, options.postCloseDrainMs ?? POST_EXIT_DRAIN_MS);
      drainTimer.unref?.();
    };

    const onExit = (code: number | null) => {
      processExited = true;
      exitCode = code ?? proc.exitCode ?? 1;
      // `exit` confirms the direct child is gone. A descendant may still
      // retain one of its pipes, so bound the remaining output drain here.
      scheduleDrain();
      finish();
    };

    const onClose = (code: number | null) => {
      processExited = true;
      exitCode = code ?? proc.exitCode ?? 1;
      // A real close confirms that the process is gone. Any pending pipe
      // drain is bounded so descendants holding inherited fds cannot keep
      // extraction pending forever.
      stopKillTimer();
      scheduleDrain();
      finish();
    };

    const onProcessError = (error: unknown) => {
      if (finished || processExited) return;
      processError = error;
      // ChildProcess emits `error` before `close` for spawn failures. Do not
      // settle on `error`: it is not confirmation that the child is closed.
      // Terminate now and let `close` perform the final cleanup.
      terminate();
      if (proc.closed) {
        processExited = true;
        scheduleDrain();
        finish();
      }
    };

    const onStdout = (stdout: string) => {
      if (finished || stdoutSettled) return;
      stdoutSettled = true;
      stdoutText = stdout;
      finish();
    };

    const onStdoutError = (error: unknown) => {
      if (finished || stdoutSettled) return;
      stdoutSettled = true;
      outputError = error;
      terminate();
      finish();
    };

    const onStderr = (stderr: string) => {
      if (finished || stderrSettled) return;
      stderrSettled = true;
      stderrText = stderr;
      finish();
    };

    const onStderrError = (error: unknown) => {
      if (finished || stderrSettled) return;
      stderrSettled = true;
      stderrError = error;
      // This rejection handler is attached immediately below. A pipe error
      // must not wait for proc.exited and must not cancel SIGKILL escalation.
      terminate();
      finish();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
      finish();
    };

    // Register lifecycle listeners before observing any promise. The
    // underlying `exited` promise rejects on ChildProcess.error, so attach a
    // rejection observer even though close is the authoritative completion.
    if (!proc.closed) {
      proc.proc.once('close', onClose);
      proc.proc.once('exit', onExit);
    }
    proc.proc.once('error', onProcessError);
    void proc.exited.then(onExit, onProcessError);
    void proc.closed?.then(() => {
      cleanupSettled = true;
      clearTimeout(cleanupTimer);
      // Escaped descendants can retain descriptors even after supervisor
      // exit. Only taskExit/cleanup and a bounded drain govern settlement.
      scheduleDrain();
      finish();
    }, cleanupFailed);

    // Observe stderr synchronously. Waiting until proc.exited resolves would
    // leave a rejected stderr promise unhandled while the child is alive.
    void Promise.resolve(stdoutPromise).then(onStdout, onStdoutError);
    void Promise.resolve(stderrPromise).then(onStderr, onStderrError);

    if (signal) {
      if (signal.aborted) {
        terminate();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import which from 'which';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  isSupervisorError,
  type SupervisedProcess,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';
import { validatedStamps } from './stamped-probe';

export const POST_EXIT_DRAIN_MS = 1_000;
export const DIAGNOSTIC_CAP_BYTES = 8 * 1024;

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const capText = (
  chunks: Buffer[],
  truncated: boolean,
  label: 'stdout' | 'stderr',
): string =>
  Buffer.concat(chunks).toString('utf-8') +
  (truncated ? `\n[${label} truncated at ${DIAGNOSTIC_CAP_BYTES} bytes]` : '');

export function destroyReader(stream: ChildProcess['stdout']): void {
  if (!stream || stream.destroyed) return;
  const ignore = () => undefined;
  stream.on('error', ignore);
  stream.once('close', () => stream.removeListener('error', ignore));
  stream.destroy();
}

export function watchCappedStream(
  stream: ChildProcess['stdout'],
  label: 'stdout' | 'stderr',
  onSettled?: (text: string, error?: unknown) => void,
): { read: () => string; stop: () => void } {
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  let settled = false;
  const read = () => capText(chunks, truncated, label);
  const onData = (value: Buffer | string) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    if (retained >= DIAGNOSTIC_CAP_BYTES) {
      truncated = true;
      return;
    }
    const room = DIAGNOSTIC_CAP_BYTES - retained;
    chunks.push(chunk.subarray(0, room));
    retained += Math.min(room, chunk.length);
    if (chunk.length > room) truncated = true;
  };
  const onEnd = () => settle();
  const settle = (error?: unknown) => {
    if (settled) return;
    settled = true;
    stream?.removeListener('data', onData);
    stream?.removeListener('end', onEnd);
    stream?.removeListener('close', onEnd);
    stream?.removeListener('error', settle);
    if (error !== undefined && stream) {
      const ignore = () => undefined;
      stream.on('error', ignore);
      stream.once('close', () => stream.removeListener('error', ignore));
    }
    onSettled?.(read(), error);
  };
  stream?.on('data', onData);
  stream?.once('end', onEnd);
  stream?.once('close', onEnd);
  stream?.on('error', settle);
  if (!stream?.readable) settle();
  return {
    read,
    stop: () => {
      stream?.removeListener('data', onData);
      destroyReader(stream);
    },
  };
}

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
        const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
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
        }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
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
      destroyReader(proc.proc.stdout);
      destroyReader(proc.proc.stderr);
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
    watchCappedStream(proc.proc.stdout, 'stdout', (text, error) => {
      stdoutSettled = true;
      stdoutText = text;
      if (error !== undefined) {
        outputError = error;
        terminate();
      }
      finish();
    });
    watchCappedStream(proc.proc.stderr, 'stderr', (text, error) => {
      stderrSettled = true;
      stderrText = text;
      if (error !== undefined) {
        stderrError = error;
        terminate();
      }
      finish();
    });

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
    ? `runtime:${process.env.PATH ?? ''}:${executable}:${found}:${stamp}`
    : undefined;
  signal?.throwIfAborted();
  if (key && validatedStamps.has(key)) return;
  const timeout = AbortSignal.timeout(DEFAULT_CLEANUP_TIMEOUT_MS);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
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
    if (key) validatedStamps.add(key);
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    signal?.throwIfAborted();
    throw new SupervisorRuntimeError({ cause: error });
  }
}

export interface SearchExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface ManagedSearch {
  // Preserve raw worker pipes; the supervisor owns lifecycle and cleanup.
  child: ChildProcess;
  // Idempotent capability, never a saved numeric PID/PGID.
  stop: () => void;
  // Task-exit status may precede transport close.
  readExit: () => SearchExit | undefined;
  // Task status + bounded output drain + supervised cleanup, not raw close.
  completed: Promise<SearchExit>;
}

export type SearchDone = { type: 'close' } & SearchExit;

// Windows has no private POSIX supervisor. Only a transport close confirms
// completion, and stop is the ChildProcess capability (never a saved PID).
export function adaptWindowsSearch(child: ChildProcess): ManagedSearch {
  let exit: SearchExit | undefined;
  let failure: string | undefined;
  const onError = (error: unknown) => {
    failure ??= toErrorMessage(error);
  };
  const completed = new Promise<SearchExit>((resolve) => {
    child.on('error', onError);
    child.once('close', (code, signal) => {
      child.removeListener('error', onError);
      exit = { code, signal, ...(failure ? { error: failure } : {}) };
      resolve(exit);
    });
  });
  return {
    child,
    completed,
    stop: () => {
      child.kill();
    },
    readExit: () => exit,
  };
}

export function adaptSpawnedSearch(spawned: ManagedSearch): ManagedSearch {
  return {
    ...spawned,
    completed: spawned.completed.catch((error) => ({
      ...(spawned.readExit() ?? { code: null, signal: null }),
      error: `Supervisor cleanup unconfirmed: ${toErrorMessage(error)}`,
    })),
  };
}

export function watchSearchCompletion(
  search: ManagedSearch,
  stop: () => void,
): {
  done: Promise<SearchDone>;
  clear: () => void;
  clearReaderErrors: () => void;
} {
  const child = search.child;
  let settle!: (result: SearchDone) => void;
  const done = new Promise<SearchDone>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let failure: string | undefined;
  const finish = (result: SearchDone) => {
    if (settled) return;
    settled = true;
    settle(result);
  };
  const onError = (error: unknown) => {
    failure ??= toErrorMessage(error);
    if (!settled) stop();
  };
  const clearReaderErrors = () => {
    child.stdout?.removeListener('error', onError);
    child.stderr?.removeListener('error', onError);
  };
  const clear = () => {
    child.removeListener('error', onError);
    clearReaderErrors();
  };
  child.on('error', onError);
  child.stdout?.on('error', onError);
  child.stderr?.on('error', onError);
  void search.completed.then((exit) => {
    clear();
    finish({ type: 'close', ...exit, error: exit.error ?? failure });
  });
  return { done, clear, clearReaderErrors };
}

export const DEFAULT_CLEANUP_WAIT_MS =
  DEFAULT_KILL_GRACE_MS + DEFAULT_CLEANUP_TIMEOUT_MS + POST_EXIT_DRAIN_MS;

export async function waitForManagedCleanup(
  completed: Promise<SearchExit>,
  timeoutMs: number,
): Promise<SearchExit | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completed,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Adapt its lifecycle without duplicating transport or termination policy.
export function adaptSupervisedSearch(
  supervised: SupervisedProcess,
  options: { postExitDrainMs?: number } = {},
): ManagedSearch {
  const child = supervised.proc;
  let exit: SearchExit | undefined;
  let stopped = false;
  let released = false;
  let closed = false;
  let finished = false;
  let cleanupError: string | undefined;
  let drainError: string | undefined;
  let pendingOutputs = 0;
  let outputsDestroyed = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drainMs = Math.max(0, options.postExitDrainMs ?? POST_EXIT_DRAIN_MS);
  let resolveCompleted!: (exit: SearchExit) => void;
  const completed = new Promise<SearchExit>((resolve) => {
    resolveCompleted = resolve;
  });
  const cleanOutputs: (() => void)[] = [];
  const finish = () => {
    if (finished || !exit || !closed || pendingOutputs) return;
    finished = true;
    clearTimeout(drainTimer);
    for (const clean of cleanOutputs) clean();
    const error = [
      ...new Set([exit.error, drainError, cleanupError].filter(Boolean)),
    ].join('; ');
    resolveCompleted({ ...exit, ...(error ? { error } : {}) });
  };
  const stop = (graceMs?: number) => {
    if (stopped || closed) return;
    stopped = true;
    void supervised.stop(graceMs).catch((error) => {
      cleanupError = `Supervisor cleanup failed: ${toErrorMessage(error)}`;
      finish();
    });
  };
  const release = () => {
    if (!exit || pendingOutputs || stopped || released || closed) return;
    released = true;
    void supervised.release().catch((error) => {
      cleanupError = `Supervisor release failed: ${toErrorMessage(error)}`;
      stop();
    });
  };
  const destroyOutputs = () => {
    if (outputsDestroyed) return;
    outputsDestroyed = true;
    for (const output of [child.stdout, child.stderr]) {
      if (!output || output.closed) continue;
      destroyReader(output);
    }
  };
  const startDrain = () => {
    if (!pendingOutputs || drainTimer || finished) return;
    drainTimer = setTimeout(() => {
      drainError = 'Output drain deadline exceeded after task exit';
      stop(0);
      destroyOutputs();
    }, drainMs);
    drainTimer.unref?.();
  };
  for (const output of [child.stdout, child.stderr]) {
    if (!output || output.readableEnded || output.closed) continue;
    pendingOutputs++;
    const clean = () => {
      output.removeListener('end', drained);
      output.removeListener('close', drained);
      output.removeListener('error', onError);
    };
    const drained = () => {
      clean();
      pendingOutputs--;
      if (!pendingOutputs) clearTimeout(drainTimer);
      release();
      finish();
    };
    const onError = (error: unknown) => {
      drainError ??= `Output reader failed: ${toErrorMessage(error)}`;
      stop();
      destroyOutputs();
    };
    output.once('end', drained);
    output.once('close', drained);
    output.on('error', onError);
    cleanOutputs.push(clean);
  }
  void supervised.exited.then(
    ({ code, signal }) => {
      if (exit || finished) return;
      exit = { code: signal ? null : code, signal };
      startDrain();
      release();
      finish();
    },
    (error) => {
      if (exit || finished) return;
      exit = { code: null, signal: null, error: toErrorMessage(error) };
      startDrain();
      release();
      finish();
    },
  );
  const onCleanup = (confirmed: boolean, error?: unknown) => {
    closed = true;
    if (!confirmed) {
      cleanupError =
        error === undefined
          ? 'Supervisor cleanup unconfirmed'
          : toErrorMessage(error) || 'Supervisor cleanup unconfirmed';
    } else if (!released && !stopped) {
      cleanupError =
        'Supervisor exited before cleanup was requested; cleanup unconfirmed';
    }
    if (!exit) {
      exit = {
        code: supervised.exitCode,
        signal: null,
        error: 'Search supervisor closed without task exit status',
      };
    }
    startDrain();
    finish();
  };
  // The common owner's closed promise now confirms the cleanup protocol and
  // rejects on unexpected death/watchdog expiry. Never substitute proc.close.
  void supervised.closed.then(
    () => onCleanup(true),
    (error) => onCleanup(false, error),
  );
  return {
    child,
    readExit: () => exit,
    stop: () => stop(),
    completed,
  };
}

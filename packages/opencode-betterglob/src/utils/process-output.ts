import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import which from 'which';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  duration,
  isSupervisorError,
  type SupervisedProcess,
  SupervisorRuntimeError,
  spawnSupervised,
} from './process-supervisor';
import { validatedStamps } from './stamped-probe';

export const POST_EXIT_DRAIN_MS = 1_000;
export const DIAGNOSTIC_CAP_BYTES = 8 * 1024;
export const DEFAULT_SEARCH_KILL_GRACE_MS = 250;

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

export function cleanupBudget(
  options: ProcessOptions & { cleanupWaitMs?: number } = {},
): number {
  return duration(
    options.cleanupWaitMs ??
      (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) +
        (options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS) +
        (options.postCloseDrainMs ?? POST_EXIT_DRAIN_MS),
    DEFAULT_CLEANUP_WAIT_MS,
  );
}

function startOutputDrain(
  child: ChildProcess,
  timeoutMs: number,
  onDeadline: () => void,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    onDeadline();
    destroyReader(child.stdout);
    destroyReader(child.stderr);
  }, timeoutMs);
  timer.unref?.();
  return timer;
}

function adaptDirectSearch(
  child: ChildProcess,
  options: ProcessOptions,
): ManagedSearch {
  let exit: SearchExit | undefined;
  let failure: unknown;
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const completed = Promise.withResolvers<SearchExit>();
  const onError = (error: unknown) => {
    failure ??= error;
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exit) return;
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
    child.removeListener('error', onError);
    exit = {
      code: code ?? 1,
      signal,
      failure,
      error: failure === undefined ? undefined : toErrorMessage(failure),
    };
    completed.resolve(exit);
  };
  child.on('error', onError);
  child.once('close', finish);
  child.once('exit', () => {
    drainTimer = startOutputDrain(
      child,
      options.postCloseDrainMs ?? POST_EXIT_DRAIN_MS,
      () => undefined,
    );
  });
  return {
    child,
    completed: completed.promise,
    readExit: () => exit,
    stop: () => {
      if (stopped || exit) return;
      stopped = true;
      child.kill();
      if (process.platform === 'win32') return;
      killTimer = setTimeout(() => {
        if (exit) return;
        child.kill('SIGKILL');
        destroyReader(child.stdout);
        destroyReader(child.stderr);
      }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      killTimer.unref?.();
    },
  };
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
  const search = owner
    ? adaptSupervisedSearch(owner, {
        postExitDrainMs: options.postCloseDrainMs,
      })
    : adaptDirectSearch(child, options);
  return collectProcess(search, owner, options, signal);
}

async function collectProcess(
  search: ManagedSearch,
  owner: SupervisedProcess | undefined,
  options: ProcessOptions,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const child = search.child;
  const text = { stdout: '', stderr: '' };
  let aborted = signal?.aborted === true;
  let stopStarted: number | undefined;
  const stopped = Promise.withResolvers<void>();
  const stop = () => {
    if (stopStarted !== undefined) return;
    stopStarted = performance.now();
    search.stop();
    stopped.resolve();
  };
  const readers = (['stdout', 'stderr'] as const).map((label) =>
    watchCappedStream(child[label], label, (value) => {
      text[label] = value;
    }),
  );
  const completion = watchSearchCompletion(search, stop);
  const onAbort = () => {
    aborted = true;
    stop();
  };
  if (aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const taskExit = owner
    ? owner.exited.then(
        () => undefined,
        () => undefined,
      )
    : new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const needsBudget = await Promise.race([
      completion.done.then(() => false),
      taskExit.then(() => true),
      stopped.promise.then(() => true),
    ]);
    const budget = cleanupBudget(options);
    const remaining = Math.max(
      0,
      budget - (performance.now() - (stopStarted ?? performance.now())),
    );
    const exit = needsBudget
      ? await waitForManagedCleanup(completion.done, remaining)
      : await completion.done;
    if (!exit)
      throw new CleanupUnconfirmedError('cleanup wait deadline exceeded');
    const original = exit.failure;
    if (original !== undefined)
      throw original instanceof Error ? original : new Error(String(original));
    return { exitCode: exit.code ?? 1, ...text, aborted };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    completion.clear();
    for (const reader of readers) reader.stop();
  }
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
  failure?: unknown;
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

export function watchSearchCompletion(
  search: ManagedSearch,
  stop: () => void,
): {
  done: Promise<SearchExit>;
  clear: () => void;
} {
  const child = search.child;
  let failure: unknown;
  const onError = (error: unknown) => {
    failure ??= error;
    stop();
  };
  const clear = () => {
    child.removeListener('error', onError);
    child.stdout?.removeListener('error', onError);
    child.stderr?.removeListener('error', onError);
  };
  child.on('error', onError);
  child.stdout?.on('error', onError);
  child.stderr?.on('error', onError);
  const done = search.completed
    .then((exit) => ({
      ...exit,
      error:
        exit.error ??
        (failure === undefined ? undefined : toErrorMessage(failure)),
      failure: exit.failure ?? failure,
    }))
    .finally(clear);
  return { done, clear };
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
  let failure: unknown;
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
    resolveCompleted({
      ...exit,
      ...(error ? { error } : {}),
      ...(failure === undefined ? {} : { failure }),
    });
  };
  const stop = (graceMs?: number) => {
    if (stopped || closed) return;
    stopped = true;
    void supervised.stop(graceMs).catch((error) => {
      failure ??= error;
      cleanupError = `Supervisor cleanup failed: ${toErrorMessage(error)}`;
      finish();
    });
  };
  const release = () => {
    if (!exit || pendingOutputs || stopped || released || closed) return;
    released = true;
    void supervised.release().catch((error) => {
      failure ??= error;
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
    drainTimer = startOutputDrain(child, drainMs, () => {
      drainError = 'Output drain deadline exceeded after task exit';
      stop(0);
    });
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
      failure ??= error;
      drainError ??= `Output reader failed: ${toErrorMessage(error)}`;
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
      failure ??= error;
      exit = { code: null, signal: null, error: toErrorMessage(error) };
      startDrain();
      release();
      finish();
    },
  );
  const onCleanup = (confirmed: boolean, error?: unknown) => {
    closed = true;
    if (!confirmed) {
      failure ??= error;
      cleanupError =
        error === undefined
          ? 'Supervisor cleanup unconfirmed'
          : toErrorMessage(error) || 'Supervisor cleanup unconfirmed';
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

import type { ChildProcess } from 'node:child_process';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  type SupervisedProcess,
} from '../../utils/process-supervisor';
import { toErrorMessage } from './runner-output';

export interface SearchExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface ManagedSearch {
  // stdout/stderr are the worker's unmodified pipes. This process owns the
  // supervisor lifecycle, not just the worker lifecycle.
  child: ChildProcess;
  // Idempotent and safe after close/disconnect. Implementations must use an
  // operation-bound capability, never fall back to a numeric PID/PGID lookup.
  stop: () => void;
  // Available once the task-exit promise settles. The runner allows its
  // pending microtask to run before interpreting transport close.
  readExit: () => SearchExit | undefined;
  // Task status + bounded output drain + supervised cleanup, not raw close.
  completed: Promise<SearchExit>;
}

export const POST_EXIT_DRAIN_MS = 1_000;
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

// Adapt the common supervisor's lifecycle; do not duplicate its transport,
// process creation, or termination policy here.
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
      // Destruction can fail asynchronously, after the run has completed.
      const ignoreError = () => undefined;
      output.on('error', ignoreError);
      output.once('close', () => output.removeListener('error', ignoreError));
      output.destroy();
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

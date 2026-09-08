import { type ChildProcess, spawn } from 'node:child_process';

export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

export class SupervisorRuntimeError extends Error {
  readonly code = 'SUPERVISOR_RUNTIME_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Process supervision infrastructure unavailable: a working Node.js runtime (node on PATH under Bun) is required before ripgrep can be used or installed.',
      options,
    );
    this.name = 'SupervisorRuntimeError';
  }
}

export class CleanupUnconfirmedError extends Error {
  readonly code = 'SUPERVISOR_CLEANUP_UNCONFIRMED';

  constructor(detail: string) {
    super(
      `Process supervisor cleanup unconfirmed: ${detail}. Descendants may still be running.`,
    );
    this.name = 'CleanupUnconfirmedError';
  }
}

/** Infrastructure failures must never be treated as a missing/invalid tool. */
export function isSupervisorError(
  error: unknown,
): error is SupervisorRuntimeError | CleanupUnconfirmedError {
  return (
    error instanceof SupervisorRuntimeError ||
    error instanceof CleanupUnconfirmedError
  );
}

export interface SupervisorOptions {
  stdin?: 'pipe' | 'inherit' | 'ignore';
  stdout?: 'pipe' | 'inherit' | 'ignore';
  stderr?: 'pipe' | 'inherit' | 'ignore';
  cwd?: string;
  env?: Record<string, string | undefined>;
  killGraceMs?: number;
  /** Parent-side allowance after the requested termination grace. */
  cleanupTimeoutMs?: number;
  supervisorExecutable?: string;
}

export interface SupervisedExit {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface SupervisedProcess {
  /** Transport process, NOT the task. Its exit alone does NOT confirm cleanup. */
  proc: ChildProcess;
  /** Task exit, independent of inherited output descriptors and cleanup. */
  exited: Promise<SupervisedExit>;
  /** Resolves only for the acknowledged cleanup protocol + expected SIGKILL.
   * Rejects on interrupted IPC, unexpected death, or parent watchdog expiry.
   * This confirms the group protocol, not termination of setsid escapees.
   */
  closed: Promise<void>;
  stop: (graceMs?: number) => Promise<void>;
  release: () => Promise<void>;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  readonly exitCode: number | null;
}

// Fixed source: executable, arguments, cwd and environment travel only over
// Node's private IPC descriptor. No shell, eval of input, or historical PGID.
// The detached supervisor is the group leader and ignores its own TERM until
// its timer sends KILL to the CURRENT group. Descendants using setsid escape
// this boundary; output readers must therefore have their own drain deadline.
const SUPERVISOR_SOURCE = `
const { spawn } = require('node:child_process');
const { closeSync } = require('node:fs');
let task;
let started = false;
let taskDone = false;
let stopping = false;
let released = false;
let graceMs = 5000;
let killTimer;
let killDeadline = Infinity;
let pendingMessages = 0;
let killing = false;
function killGroup() {
  if (killing) return;
  killing = true;
  // Flush the cleanup marker before self-KILL; bare transport death must never
  // be interpreted as successful cleanup by the parent.
  if (process.connected) {
    process.send({ type: 'cleanup' }, () => process.kill(0, 'SIGKILL'));
  } else {
    process.kill(0, 'SIGKILL');
  }
}
function send(message) {
  if (!process.connected) { stop(); return; }
  pendingMessages++;
  process.send(message, error => {
    pendingMessages--;
    if (error) stop();
    else if (released) release();
  });
}
function closeOutput() {
  for (const fd of [1, 2]) { try { closeSync(fd); } catch {} }
}
function stop(grace = graceMs, force = false) {
  if (force) { killGroup(); return; }
  if (!stopping) {
    stopping = true;
    process.kill(0, 'SIGTERM');
  }
  const deadline = performance.now() + grace;
  if (deadline < killDeadline) {
    killDeadline = deadline;
    clearTimeout(killTimer);
    killTimer = setTimeout(killGroup, grace);
  }
}
function release() {
  released = true;
  if (taskDone && !stopping && pendingMessages === 0) {
    // The task may have left descendants in this group even after closing
    // both output pipes. Kill from inside the still-live supervisor so no
    // historical PGID can be reused by another process.
    killGroup();
  }
}
process.on('SIGTERM', () => { if (!stopping) stop(); });
process.on('disconnect', () => stop());
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'stop') {
    stop(message.graceMs, message.force === true);
  } else if (message.type === 'release') {
    release();
  } else if (message.type === 'start' && !started && !stopping) {
    started = true;
    graceMs = message.graceMs;
    try {
      task = spawn(message.command[0], message.command.slice(1), {
        cwd: message.cwd, env: message.env, shell: false,
        detached: false, stdio: [0, 1, 2],
      });
      // Only the task/descendants retain the output writers. Keeping these
      // open in the supervisor would make output drain depend on release.
      closeOutput();
      task.once('error', error => {
        taskDone = true;
        send({ type: 'taskError', message: error.message, code: error.code });
        if (released) release();
      });
      task.once('exit', (code, signal) => {
        taskDone = true;
        send({ type: 'taskExit', code: code === null ? 1 : code, signal });
        if (released) release();
      });
    } catch (error) {
      taskDone = true;
      closeOutput();
      send({
        type: 'taskError',
        message: error instanceof Error ? error.message : String(error),
        code: error?.code,
      });
      if (released) release();
    }
  }
});
`;

function duration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(value, 2_147_483_647))
    : DEFAULT_KILL_GRACE_MS;
}

/** POSIX-only primitive. The caller drains output, then releases or stops. */
export function spawnSupervised(
  command: string[],
  options: SupervisorOptions = {},
): SupervisedProcess {
  if (process.platform === 'win32') {
    throw new Error('POSIX process supervision is unavailable on Windows');
  }
  // OpenCode may host plugins in Bun. Use Node, not Bun's child IPC emulation.
  const node =
    options.supervisorExecutable ??
    (process.versions.bun ? 'node' : process.execPath);
  const proc = spawn(
    node,
    ['--input-type=commonjs', '--eval', SUPERVISOR_SOURCE],
    {
      detached: true,
      stdio: [
        options.stdin ?? 'ignore',
        options.stdout ?? 'pipe',
        options.stderr ?? 'pipe',
        'ipc',
      ],
    },
  );
  let code: number | null = null;
  let taskSettled = false;
  let stopped = false;
  let done = false;
  let cleanupAcknowledged = false;
  let cleanupRequested = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupDeadline = Infinity;
  let resolveExit!: (exit: SupervisedExit) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<SupervisedExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // A caller may install its await much later than an IPC/spawn failure.
  void exited.catch(() => undefined);
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => undefined);
  const failTask = (error: Error) => {
    if (taskSettled) return;
    taskSettled = true;
    rejectExit(error);
  };
  const failCleanup = (detail: string) => {
    if (done) return;
    done = true;
    clearTimeout(cleanupTimer);
    const error = new CleanupUnconfirmedError(detail);
    failTask(error);
    rejectClosed(error);
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    // Do not signal a saved PID/PGID. A stopped supervisor may remain alive;
    // detach our handles without claiming it or its descendants were killed.
    if (proc.connected) proc.disconnect();
    proc.unref();
  };
  const watchCleanup = (grace: number) => {
    cleanupRequested = true;
    const wait = Math.min(
      grace + duration(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS),
      2_147_483_647,
    );
    const deadline = performance.now() + wait;
    if (done || deadline >= cleanupDeadline) return;
    cleanupDeadline = deadline;
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(
      () => failCleanup('parent watchdog expired'),
      wait,
    );
  };
  const complete = (_code: number | null, signal: NodeJS.Signals | null) => {
    if (done) return;
    if (!cleanupRequested || !cleanupAcknowledged || signal !== 'SIGKILL') {
      failCleanup('supervisor exited without the cleanup protocol');
      return;
    }
    done = true;
    clearTimeout(cleanupTimer);
    if (!taskSettled) {
      if (stopped) {
        taskSettled = true;
        code = 1;
        resolveExit({ code, signal: null });
      } else {
        failTask(new Error('Process supervisor exited before taskExit'));
      }
    }
    resolveClosed();
  };
  const send = (message: object): boolean => {
    if (done) return false;
    if (!proc.connected) {
      failCleanup('control channel disconnected');
      return false;
    }
    try {
      // A failed control write must NEVER fall back to a PID/group signal.
      proc.send(message, (error) => {
        if (!error) return;
        failTask(error);
        failCleanup('control write failed');
      });
      return true;
    } catch (error) {
      failTask(error instanceof Error ? error : new Error(String(error)));
      failCleanup('control write failed');
      return false;
    }
  };
  proc.on('error', (error) => {
    failTask(
      proc.pid === undefined
        ? new SupervisorRuntimeError({ cause: error })
        : error,
    );
    failCleanup('supervisor transport error');
  });
  proc.once('disconnect', () => {
    if (!cleanupAcknowledged) failCleanup('control channel interrupted');
  });
  proc.once('exit', complete);
  proc.once('close', complete); // Includes spawn failures without an exit.
  proc.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || done) return;
    const event = message as Record<string, unknown>;
    if (event.type === 'cleanup' && cleanupRequested) {
      cleanupAcknowledged = true;
      return;
    }
    if (taskSettled) return;
    if (event.type === 'taskExit' && typeof event.code === 'number') {
      taskSettled = true;
      code = event.code;
      resolveExit({
        code: event.code,
        signal:
          typeof event.signal === 'string'
            ? (event.signal as NodeJS.Signals)
            : null,
      });
    } else if (event.type === 'taskError') {
      failTask(
        Object.assign(new Error(String(event.message)), { code: event.code }),
      );
    }
  });
  const graceMs = duration(options.killGraceMs);
  proc.once('spawn', () => {
    send({
      type: 'start',
      command,
      cwd: options.cwd,
      env: options.env,
      graceMs,
    });
  });
  return {
    proc,
    exited,
    closed,
    stop: (grace = graceMs) => {
      stopped = true;
      watchCleanup(duration(grace));
      send({ type: 'stop', graceMs: duration(grace) });
      return closed;
    },
    release: () => {
      if (!stopped) {
        watchCleanup(0);
        send({ type: 'release' });
      }
      return closed;
    },
    kill: (signal = 'SIGTERM') => {
      if (
        signal !== 'SIGTERM' &&
        signal !== 'SIGKILL' &&
        signal !== 15 &&
        signal !== 9
      ) {
        return false;
      }
      stopped = true;
      watchCleanup(signal === 'SIGKILL' || signal === 9 ? 0 : graceMs);
      return send({
        type: 'stop',
        graceMs,
        force: signal === 'SIGKILL' || signal === 9,
      });
    },
    get exitCode() {
      return code;
    },
  };
}

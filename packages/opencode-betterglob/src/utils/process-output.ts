import type { CrossSpawnResult } from './compat';
import {
  CleanupUnconfirmedError,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  isSupervisorError,
  SupervisorRuntimeError,
} from './process-supervisor';

// Waits for a helper process after termination. There is no implicit
// deadline for healthy runs: the grace window that escalates SIGTERM to
// SIGKILL starts only on abort, failure or expired post-task drain, so long
// legitimate extractions are never aborted early.
export const ABORT_KILL_GRACE_MS = 5_000;
export const POST_EXIT_DRAIN_MS = 1_000;

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

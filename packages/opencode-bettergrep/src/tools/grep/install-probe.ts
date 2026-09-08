import { sync as whichSync } from 'which';
import {
  type CrossSpawnResult,
  crossSpawn,
  TERMINATE_HARD_WAIT_MS,
  terminateProcess,
  withTimeout,
} from '../../utils/compat';
import { readTextStream } from './json-stream';

const PROBE_TIMEOUT_MS = 5_000;

export function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export async function waitForExitAndStderr(
  proc: CrossSpawnResult,
  stderrPromise: Promise<string>,
): Promise<{ exitCode: number; stderr: string }> {
  const [exitResult, stderrResult] = await Promise.allSettled([
    proc.exited,
    stderrPromise,
  ]);

  return {
    exitCode: exitResult.status === 'fulfilled' ? exitResult.value : 1,
    stderr: stderrResult.status === 'fulfilled' ? stderrResult.value : '',
  };
}

export function hasExecutable(name: string): boolean {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved)
      ? (resolved[0] ?? '').length > 0
      : (resolved ?? '').length > 0;
  } catch {
    return false;
  }
}

export async function probeCommand(
  command: string[],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  throwIfAborted(signal);
  let proc: CrossSpawnResult;
  try {
    proc = crossSpawn(command, { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { exitCode: 1, stdout: '', stderr: '' };
  }

  const stdoutPromise = readTextStream(proc.proc.stdout, 1_000_000);
  const stderrPromise = readTextStream(proc.proc.stderr, 1_000_000);
  const exitPromise = proc.exited.then(
    (exitCode) => ({ kind: 'exit' as const, exitCode }),
    () => ({ kind: 'exit' as const, exitCode: 1 }),
  );
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<{ kind: 'stop' }>((resolve) => {
    resolveStop = () => resolve({ kind: 'stop' });
  });
  const onAbort = () => {
    resolveStop?.();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      resolveStop?.();
    },
    Math.max(1, timeoutMs),
  );
  timeoutId.unref?.();

  let outcome: { kind: 'exit'; exitCode: number } | { kind: 'stop' };
  try {
    outcome = await Promise.race([exitPromise, stopPromise]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }

  if (outcome.kind === 'stop') {
    // Escalate SIGTERM -> SIGKILL so probes never hang on stubborn children.
    await terminateProcess(proc);
  }

  // Bound the post-stop drain: descendants inheriting the pipes can keep
  // stdout/stderr open after the direct child is gone. When the drain
  // deadline passes, force-destroy the pipes; readers keep whatever was
  // already collected instead of waiting for the descendants.
  const drain = Promise.all([
    stdoutPromise.catch(() => ''),
    stderrPromise.catch(() => ''),
  ]) as Promise<[string, string]>;
  if ((await withTimeout(drain, TERMINATE_HARD_WAIT_MS)) === 'timeout') {
    proc.proc.stdout?.destroy();
    proc.proc.stderr?.destroy();
  }
  const [stdout, stderr] = await drain;

  throwIfAborted(signal);
  return {
    exitCode: outcome.kind === 'exit' ? outcome.exitCode : 1,
    stdout,
    stderr,
  };
}

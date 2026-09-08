import { spawnSync } from 'node:child_process';
import { sync as whichSync } from 'which';
import {
  type CrossSpawnResult,
  crossSpawn,
  TERMINATE_HARD_WAIT_MS,
  terminateProcess,
  withTimeout,
} from '../../utils/compat';
import { readTextStream } from './json-stream';
import { AbortWaitError } from './runtime';

const PROBE_TIMEOUT_MS = 5_000;

export async function probeExecutable(
  binaryPath: string,
  args: string[] = ['--version'],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  if (signal?.aborted) {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  let proc: CrossSpawnResult;
  try {
    proc = crossSpawn([binaryPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
  }

  const stdoutPromise = readTextStream(proc.proc.stdout, 1_000_000);
  const stderrPromise = readTextStream(proc.proc.stderr, 1_000_000);
  const exitPromise = proc.exited.then(
    (exitCode) => ({ kind: 'exit' as const, exitCode }),
    () => ({ kind: 'exit' as const, exitCode: 1 }),
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let stopKind: 'timeout' | 'cancel' | undefined;
  let resolveStop: (() => void) | undefined;
  const stopPromise = new Promise<{ kind: 'stop' }>((resolve) => {
    resolveStop = () => resolve({ kind: 'stop' });
  });
  const onAbort = () => {
    stopKind = 'cancel';
    resolveStop?.();
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  timeoutId = setTimeout(
    () => {
      stopKind = 'timeout';
      resolveStop?.();
    },
    Math.max(1, timeoutMs),
  );
  timeoutId.unref?.();

  let outcome: { kind: 'exit'; exitCode: number } | { kind: 'stop' };
  try {
    outcome = await Promise.race([exitPromise, stopPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }

  if (outcome.kind === 'stop') {
    // Escalate SIGTERM -> SIGKILL so probes never hang on stubborn children.
    await terminateProcess(proc);
  }

  // Bound the post-stop drain too: descendants inheriting the pipes can keep
  // stdout/stderr open long after the direct child is gone. When the drain
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
  const [stdoutResult, stderrResult] = await drain;

  if (stopKind === 'cancel') {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  return {
    exitCode: outcome.kind === 'exit' ? outcome.exitCode : 1,
    stdout: stdoutResult,
    stderr: stderrResult,
    timedOut: stopKind === 'timeout',
  };
}

export function defaultFindExecutable(name: string): string | null {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved) ? (resolved[0] ?? null) : (resolved ?? null);
  } catch {
    return null;
  }
}

export function defaultIsSupportedRipgrep(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });

    if (result.error || result.status === null || result.status !== 0) {
      return false;
    }

    const output =
      `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`.toLowerCase();
    return output.includes('ripgrep');
  } catch {
    return false;
  }
}

export function defaultIsSupportedGrep(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });

    if (result.error || result.status === null || result.status !== 0) {
      return false;
    }

    const firstLine = result.stdout?.toString().split(/\r?\n/, 1)[0] ?? '';
    return firstLine.includes('GNU grep');
  } catch {
    return false;
  }
}

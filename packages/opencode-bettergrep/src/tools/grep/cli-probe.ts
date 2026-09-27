import { spawnSync } from 'node:child_process';
import { sync as whichSync } from 'which';
import {
  createAbortError,
  createSearchAbortError,
  throwIfAborted,
} from '../../utils/abort';
import {
  type CrossSpawnResult,
  crossSpawn,
  TERMINATE_HARD_WAIT_MS,
  terminateProcess,
  withTimeout,
} from '../../utils/compat';
import { readTextStream } from './json-stream';
import { isTransientStderr } from './runtime';

const PROBE_TIMEOUT_MS = 5_000;

export { createAbortError, throwIfAborted } from '../../utils/abort';
export { waitForExitAndStderr } from './runtime';

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createSearchAbortError());
  let rejectAbort!: (reason: Error) => void;
  const cancelled = new Promise<T>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(createSearchAbortError());
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([promise, cancelled]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProbe(
  command: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  abortError: () => Error,
  spawn: typeof crossSpawn = crossSpawn,
): Promise<ProbeResult> {
  throwIfAborted(signal, abortError);

  let proc: CrossSpawnResult;
  try {
    proc = spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
  }

  const stdoutPromise = readTextStream(proc.proc.stdout, 1_000_000);
  const stderrPromise = readTextStream(proc.proc.stderr, 1_000_000);
  const exitPromise = proc.exited.then(
    (exitCode) => ({ kind: 'exit' as const, exitCode }),
    () => ({ kind: 'exit' as const, exitCode: 1 }),
  );
  let stopKind: 'timeout' | 'cancel' | undefined;
  let resolveStop!: () => void;
  const stopPromise = new Promise<{ kind: 'stop' }>((resolve) => {
    resolveStop = () => resolve({ kind: 'stop' });
  });
  const onAbort = () => {
    stopKind = 'cancel';
    resolveStop();
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(
    () => {
      stopKind = 'timeout';
      resolveStop();
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

  if (stopKind === 'cancel' || signal?.aborted) throw abortError();

  return {
    exitCode: outcome.kind === 'exit' ? outcome.exitCode : 1,
    stdout: stdoutResult,
    stderr: stderrResult,
    timedOut: stopKind === 'timeout',
  };
}

export function probeExecutable(
  binaryPath: string,
  args: string[] = ['--version'],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
  spawn: typeof crossSpawn = crossSpawn,
): Promise<ProbeResult> {
  return runProbe(
    [binaryPath, ...args],
    signal,
    timeoutMs,
    createSearchAbortError,
    spawn,
  );
}

export async function probeCommand(
  command: string[],
  signal?: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Pick<ProbeResult, 'exitCode' | 'stdout' | 'stderr'>> {
  const { exitCode, stdout, stderr } = await runProbe(
    command,
    signal,
    timeoutMs,
    createAbortError,
  );
  return { exitCode, stdout, stderr };
}

export function defaultFindExecutable(name: string): string | null {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved) ? (resolved[0] ?? null) : (resolved ?? null);
  } catch {
    return null;
  }
}

export function hasExecutable(name: string): boolean {
  return defaultFindExecutable(name) !== null;
}

function defaultIsSupported(binaryPath: string, kind: 'rg' | 'grep'): boolean {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return false;
    if (kind === 'grep') {
      return (result.stdout?.toString().split(/\r?\n/, 1)[0] ?? '').includes(
        'GNU grep',
      );
    }
    return `${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`
      .toLowerCase()
      .includes('ripgrep');
  } catch {
    return false;
  }
}

export function defaultIsSupportedRipgrep(binaryPath: string): boolean {
  return defaultIsSupported(binaryPath, 'rg');
}

export function defaultIsSupportedGrep(binaryPath: string): boolean {
  return defaultIsSupported(binaryPath, 'grep');
}

interface GnuCheck {
  error?: string;
  cacheable: boolean;
}
interface GnuEntry {
  promise: Promise<GnuCheck>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const GNU_GREP_CACHE = new Map<string, GnuEntry>();

async function checkGnuGrep(
  binaryPath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<GnuCheck> {
  const { exitCode, stdout, stderr, timedOut } = await probeExecutable(
    binaryPath,
    ['--version'],
    signal,
    timeoutMs,
  );
  if (timedOut)
    return { error: 'GNU grep validation timed out.', cacheable: false };
  if (exitCode !== 0)
    return {
      error: stderr || `grep --version exited with code ${String(exitCode)}`,
      cacheable: !isTransientStderr(stderr),
    };
  const firstLine = stdout.trim().split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.includes('GNU grep'))
    return {
      error: firstLine
        ? 'System grep fallback requires GNU grep; the detected grep is not GNU grep.'
        : 'System grep fallback could not validate GNU grep version output.',
      cacheable: firstLine.length > 0,
    };
  return { cacheable: true };
}

export async function ensureGnuGrep(
  binaryPath: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string | undefined> {
  let entry = GNU_GREP_CACHE.get(binaryPath);
  if (!entry) {
    const controller = new AbortController();
    const created: GnuEntry = {
      controller,
      waiters: 0,
      settled: false,
      promise: checkGnuGrep(binaryPath, timeoutMs, controller.signal),
    };
    created.promise = created.promise.then(
      (result) => {
        created.settled = true;
        if (!result.cacheable && GNU_GREP_CACHE.get(binaryPath) === created)
          GNU_GREP_CACHE.delete(binaryPath);
        return result;
      },
      (error) => {
        created.settled = true;
        if (GNU_GREP_CACHE.get(binaryPath) === created)
          GNU_GREP_CACHE.delete(binaryPath);
        throw error;
      },
    );
    void created.promise.catch(() => undefined);
    GNU_GREP_CACHE.set(binaryPath, created);
    entry = created;
  }
  entry.waiters += 1;
  try {
    return (await raceWithAbort(entry.promise, signal)).error;
  } finally {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0 && !entry.settled) {
      if (GNU_GREP_CACHE.get(binaryPath) === entry)
        GNU_GREP_CACHE.delete(binaryPath);
      entry.controller.abort();
    }
  }
}

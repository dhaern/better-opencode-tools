import which from 'which';
import { AbortWaitError, raceSignal } from '../../utils/abort';
import {
  crossSpawn,
  ensureSupervisorRuntime,
  waitForProcessOutputWithAbortGrace,
} from '../../utils/compat';
import { logAsync } from '../../utils/logger';
import { isSupervisorError } from '../../utils/process-supervisor';
import { RG_BINARY } from './constants';
import { installLatestStableRipgrep } from './downloader';
import { getInstalledRipgrepPathAsync } from './rg-cache';

export interface ResolvedGlobCli {
  path: string;
  backend: 'rg';
  source: 'system-rg' | 'managed-rg' | 'missing-rg';
}

interface GlobResolverDependencies {
  ensureSupervisorRuntimeAsync?: (signal?: AbortSignal) => Promise<void>;
  findExecutableAsync?: (
    name: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  getInstalledRipgrepPathAsync?: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
  installLatestStableRipgrep?: (signal?: AbortSignal) => Promise<string>;
  validateExecutableAsync?: (
    file: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  logger?: (
    message: string,
    data?: unknown,
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

interface SharedAutoInstallState {
  promise: Promise<ResolvedGlobCli>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

let state: SharedAutoInstallState | null = null;
const PROBE_TIMEOUT_MS = 5_000;

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function defaultFindExecutableAsync(
  name: string,
): Promise<string | null> {
  try {
    return await which(name, { nothrow: true });
  } catch (error) {
    if (isMissingExecutable(error)) return null;
    throw error;
  }
}

async function defaultValidateExecutableAsync(
  file: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    throw new AbortWaitError();
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  const probeSignal = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;

  try {
    const proc = crossSpawn([file, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
      killProcessGroup: process.platform !== 'win32',
    });
    const stdoutPromise = proc.stdout();
    const stderrPromise = proc.stderr();
    const result = await waitForProcessOutputWithAbortGrace(
      proc,
      stderrPromise,
      probeSignal,
      stdoutPromise,
      { killGraceMs: 250, postCloseDrainMs: 250 },
    );

    if (signal?.aborted) {
      throw new AbortWaitError();
    }
    if (result.aborted || timeout.signal.aborted) {
      throw new Error('ripgrep executable validation timed out.');
    }
    if (result.exitCode !== 0) return false;

    return `${result.stdout}\n${result.stderr}`
      .toLowerCase()
      .includes('ripgrep');
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    if (signal?.aborted) {
      throw new AbortWaitError();
    }
    if (isMissingExecutable(error)) return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveGlobCliAsync(
  deps: GlobResolverDependencies = {},
  signal?: AbortSignal,
): Promise<ResolvedGlobCli> {
  if (signal?.aborted) {
    throw new AbortWaitError();
  }

  await race(
    (deps.ensureSupervisorRuntimeAsync ?? ensureSupervisorRuntime)(signal),
    signal,
  );

  const find = deps.findExecutableAsync ?? defaultFindExecutableAsync;
  const validate =
    deps.validateExecutableAsync ?? defaultValidateExecutableAsync;
  const system = await race(find(RG_BINARY, signal), signal);

  if (system && (await race(validate(system, signal), signal))) {
    return { path: system, backend: 'rg', source: 'system-rg' };
  }

  const installed = deps.getInstalledRipgrepPathAsync
    ? await race(deps.getInstalledRipgrepPathAsync(signal), signal)
    : await getInstalledRipgrepPathAsync(signal);
  if (installed) {
    return { path: installed, backend: 'rg', source: 'managed-rg' };
  }

  return { path: RG_BINARY, backend: 'rg', source: 'missing-rg' };
}

function isResolved(cli: ResolvedGlobCli): boolean {
  return cli.source !== 'missing-rg';
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof AbortWaitError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function race<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return raceSignal(promise, signal, { reason: () => new AbortWaitError() });
}

function release(current: SharedAutoInstallState): void {
  current.waiters = Math.max(0, current.waiters - 1);

  if (current.waiters > 0 || current.settled) return;
  if (state === current) state = null;
  current.controller.abort();
}

function wait(
  current: SharedAutoInstallState,
  signal?: AbortSignal,
): Promise<ResolvedGlobCli> {
  current.waiters += 1;
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release(current);
  };

  return race(current.promise, signal).finally(done);
}

function create(deps: GlobResolverDependencies): SharedAutoInstallState {
  const install = deps.installLatestStableRipgrep ?? installLatestStableRipgrep;
  const controller = new AbortController();
  const current: SharedAutoInstallState = {
    controller,
    waiters: 0,
    settled: false,
    promise: Promise.resolve({
      path: RG_BINARY,
      backend: 'rg' as const,
      source: 'missing-rg' as const,
    }),
  };

  current.promise = (async () => {
    try {
      return {
        path: await install(controller.signal),
        backend: 'rg' as const,
        source: 'managed-rg' as const,
      };
    } catch (error) {
      if (isSupervisorError(error)) throw error;
      if (isAbortLike(error) || controller.signal.aborted) {
        throw new AbortWaitError();
      }

      const logger = deps.logger ?? logAsync;
      try {
        await race(
          Promise.resolve(
            logger(
              'ripgrep auto-install failed and no fallback is allowed.',
              { error: error instanceof Error ? error.message : String(error) },
              controller.signal,
            ),
          ),
          controller.signal,
        );
      } catch {
        // Logging must not mask the installation failure; late failures are
        // observed by race even when the last waiter has cancelled.
      }
      throw new Error(
        `ripgrep (rg) is required for glob search and auto-install failed.${error instanceof Error && error.message.length > 0 ? ` Auto-install error: ${error.message}` : ''}`,
      );
    } finally {
      current.settled = true;
      if (state === current) state = null;
    }
  })();

  return current;
}

export async function resolveGlobCliWithAutoInstall(
  deps: GlobResolverDependencies = {},
  signal?: AbortSignal,
  options: { allowAutoInstall?: boolean } = {},
): Promise<ResolvedGlobCli> {
  if (signal?.aborted) {
    throw new AbortWaitError();
  }

  const current = await resolveGlobCliAsync(deps, signal);
  if (isResolved(current)) return current;

  // The install_ripgrep permission is asked once per execution by the tool.
  // If it was not granted (e.g. a preflight found a system rg that then
  // vanished), fail closed instead of downloading or mutating the cache.
  if (options.allowAutoInstall !== true) {
    throw new Error(
      'ripgrep (rg) is required for glob search and auto-install was not authorized for this execution.',
    );
  }

  if (state) return wait(state, signal);

  state = create(deps);
  return wait(state, signal);
}

export function resetGlobCliResolverForTests(): void {
  state = null;
}

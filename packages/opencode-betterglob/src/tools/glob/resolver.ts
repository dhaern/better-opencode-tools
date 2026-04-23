import { spawnSync } from 'node:child_process';
import { sync as whichSync } from 'which';
import { log } from '../../utils';
import { RG_BINARY } from './constants';
import {
  getInstalledRipgrepPath,
  installLatestStableRipgrep,
} from './downloader';

export class AbortWaitError extends Error {}

export interface ResolvedGlobCli {
  path: string;
  backend: 'rg';
  source: 'system-rg' | 'managed-rg' | 'missing-rg';
}

interface GlobResolverDependencies {
  findExecutable?: (name: string) => string | null;
  getInstalledRipgrepPath?: () => string | null;
  installLatestStableRipgrep?: (signal?: AbortSignal) => Promise<string>;
  validateExecutable?: (file: string) => boolean;
  logger?: (message: string, data?: unknown) => void;
}

interface SharedAutoInstallState {
  promise: Promise<ResolvedGlobCli>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

let state: SharedAutoInstallState | null = null;
const PROBE_TIMEOUT_MS = 5_000;

function defaultFindExecutable(name: string): string | null {
  try {
    const resolved = whichSync(name, { nothrow: true });
    return Array.isArray(resolved) ? (resolved[0] ?? null) : (resolved ?? null);
  } catch {
    return null;
  }
}

function defaultValidateExecutable(file: string): boolean {
  try {
    const result = spawnSync(file, ['--version'], {
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

function resolveSync(deps: GlobResolverDependencies = {}): ResolvedGlobCli {
  const find = deps.findExecutable ?? defaultFindExecutable;
  const managed = deps.getInstalledRipgrepPath ?? getInstalledRipgrepPath;
  const validate = deps.validateExecutable ?? defaultValidateExecutable;
  const system = find(RG_BINARY);

  if (system && validate(system)) {
    return { path: system, backend: 'rg', source: 'system-rg' };
  }

  const installed = managed();
  if (installed) {
    return { path: installed, backend: 'rg', source: 'managed-rg' };
  }

  return { path: RG_BINARY, backend: 'rg', source: 'missing-rg' };
}

export function resolveGlobCli(
  deps: GlobResolverDependencies = {},
): ResolvedGlobCli {
  return resolveSync(deps);
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
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new AbortWaitError('Search was cancelled before execution started.'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        new AbortWaitError('Search was cancelled before execution started.'),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
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
      if (isAbortLike(error) || controller.signal.aborted) {
        throw new AbortWaitError(
          'Search was cancelled before execution started.',
        );
      }

      const logger = deps.logger ?? log;
      logger('ripgrep auto-install failed and no fallback is allowed.', {
        error: error instanceof Error ? error.message : String(error),
      });
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
): Promise<ResolvedGlobCli> {
  if (signal?.aborted) {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  const current = resolveSync(deps);
  if (isResolved(current)) return current;

  if (state) return wait(state, signal);

  state = create(deps);
  return wait(state, signal);
}

export function resetGlobCliResolverForTests(): void {
  state = null;
}

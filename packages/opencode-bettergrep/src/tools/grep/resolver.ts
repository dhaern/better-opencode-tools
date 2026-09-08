import { log } from '../../utils';
import {
  defaultFindExecutable,
  defaultIsSupportedGrep,
  defaultIsSupportedRipgrep,
  probeExecutable,
} from './cli-probe';
import { GREP_BINARY, RG_BINARY } from './constants';
import { installLatestStableRipgrep } from './downloader';
import {
  getInstalledRipgrepPath,
  getInstalledRipgrepPathAsync,
} from './rg-cache';
import { AbortWaitError } from './runtime';
import type { GrepBackend } from './types';

export interface ResolvedGrepCli {
  path: string;
  backend: GrepBackend;
  source: 'system-rg' | 'managed-rg' | 'system-gnu-grep' | 'missing-rg';
}

interface GrepResolverDependencies {
  findExecutable?: (name: string) => string | null;
  getInstalledRipgrepPath?: () => string | null;
  getInstalledRipgrepPathAsync?: (
    signal?: AbortSignal,
  ) => Promise<string | null>;
  installLatestStableRipgrep?: (signal?: AbortSignal) => Promise<string>;
  isSupportedRipgrep?: (path: string) => boolean;
  isSupportedGrep?: (path: string) => boolean;
  logger?: (message: string, data?: unknown) => void;
}

interface SharedAutoInstallState {
  promise: Promise<ResolvedGrepCli>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

let autoInstallState: SharedAutoInstallState | null = null;

function buildUnavailableBackendMessage(error?: unknown): string {
  const suffix =
    error instanceof Error && error.message.length > 0
      ? ` Auto-install error: ${error.message}`
      : '';

  return `Neither ripgrep (rg) nor GNU grep is available. Checked system rg, managed rg, ripgrep auto-install, and system grep.${suffix}`;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof AbortWaitError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function resolveSync(deps: GrepResolverDependencies = {}): ResolvedGrepCli {
  const findExecutable = deps.findExecutable ?? defaultFindExecutable;
  const getManagedRipgrepPath =
    deps.getInstalledRipgrepPath ?? getInstalledRipgrepPath;
  const isSupportedRipgrep =
    deps.isSupportedRipgrep ?? defaultIsSupportedRipgrep;
  const isSupportedGrep = deps.isSupportedGrep ?? defaultIsSupportedGrep;

  const systemRg = findExecutable(RG_BINARY);
  if (systemRg && isSupportedRipgrep(systemRg)) {
    return {
      path: systemRg,
      backend: 'rg',
      source: 'system-rg',
    };
  }

  const managedRg = getManagedRipgrepPath();
  if (managedRg) {
    return {
      path: managedRg,
      backend: 'rg',
      source: 'managed-rg',
    };
  }

  const systemGrep = findExecutable(GREP_BINARY);
  if (systemGrep && isSupportedGrep(systemGrep)) {
    return {
      path: systemGrep,
      backend: 'grep',
      source: 'system-gnu-grep',
    };
  }

  return {
    path: RG_BINARY,
    backend: 'rg',
    source: 'missing-rg',
  };
}

async function resolveAsync(
  deps: GrepResolverDependencies = {},
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  const findExecutable = deps.findExecutable ?? defaultFindExecutable;
  const systemRg = findExecutable(RG_BINARY);

  if (systemRg) {
    const supported = deps.isSupportedRipgrep
      ? deps.isSupportedRipgrep(systemRg)
      : undefined;
    if (supported === true) {
      return { path: systemRg, backend: 'rg', source: 'system-rg' };
    }

    if (supported === undefined) {
      const probe = await probeExecutable(systemRg, ['--version'], signal);
      if (
        !probe.timedOut &&
        probe.exitCode === 0 &&
        /ripgrep/i.test(`${probe.stdout}\n${probe.stderr}`)
      ) {
        return { path: systemRg, backend: 'rg', source: 'system-rg' };
      }
    }
  }

  const managedRg = deps.getInstalledRipgrepPathAsync
    ? await deps.getInstalledRipgrepPathAsync(signal)
    : deps.getInstalledRipgrepPath
      ? deps.getInstalledRipgrepPath()
      : await getInstalledRipgrepPathAsync(signal);
  if (managedRg) {
    return { path: managedRg, backend: 'rg', source: 'managed-rg' };
  }

  const systemGrep = findExecutable(GREP_BINARY);
  if (systemGrep) {
    const supported = deps.isSupportedGrep
      ? deps.isSupportedGrep(systemGrep)
      : undefined;
    if (supported === true) {
      return {
        path: systemGrep,
        backend: 'grep',
        source: 'system-gnu-grep',
      };
    }

    if (supported === undefined) {
      const probe = await probeExecutable(systemGrep, ['--version'], signal);
      if (
        !probe.timedOut &&
        probe.exitCode === 0 &&
        /^.*GNU grep/m.test(probe.stdout.split(/\r?\n/, 1)[0] ?? '')
      ) {
        return {
          path: systemGrep,
          backend: 'grep',
          source: 'system-gnu-grep',
        };
      }
    }
  }

  return { path: RG_BINARY, backend: 'rg', source: 'missing-rg' };
}

export function resolveGrepCli(
  deps: GrepResolverDependencies = {},
): ResolvedGrepCli {
  return resolveSync(deps);
}

function isResolvedRipgrep(cli: ResolvedGrepCli): boolean {
  return cli.backend === 'rg' && cli.source !== 'missing-rg';
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }

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

function releaseAutoInstallWaiter(state: SharedAutoInstallState): void {
  state.waiters = Math.max(0, state.waiters - 1);

  if (state.waiters > 0 || state.settled) {
    return;
  }

  if (autoInstallState === state) {
    autoInstallState = null;
  }

  state.controller.abort();
}

function waitForSharedAutoInstall(
  state: SharedAutoInstallState,
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  state.waiters += 1;

  let released = false;
  const release = () => {
    if (released) {
      return;
    }

    released = true;
    releaseAutoInstallWaiter(state);
  };

  return raceWithAbort(state.promise, signal).finally(release);
}

function createSharedAutoInstall(
  deps: GrepResolverDependencies,
): SharedAutoInstallState {
  const installManagedRipgrep =
    deps.installLatestStableRipgrep ?? installLatestStableRipgrep;
  const controller = new AbortController();
  const state: SharedAutoInstallState = {
    controller,
    waiters: 0,
    settled: false,
    promise: Promise.resolve({
      path: RG_BINARY,
      backend: 'rg' as const,
      source: 'missing-rg' as const,
    }),
  };

  state.promise = (async () => {
    try {
      const installedPath = await installManagedRipgrep(controller.signal);
      return {
        path: installedPath,
        backend: 'rg' as const,
        source: 'managed-rg' as const,
      };
    } catch (error) {
      if (isAbortLikeError(error) || controller.signal.aborted) {
        throw new AbortWaitError(
          'Search was cancelled before execution started.',
        );
      }

      const fallback = await resolveAsync(deps, controller.signal);
      const logger = deps.logger ?? log;

      if (fallback.backend === 'grep') {
        logger('ripgrep auto-install failed; falling back to GNU grep.', {
          error: error instanceof Error ? error.message : String(error),
          grep_path: fallback.path,
        });
        return fallback;
      }

      logger('ripgrep auto-install failed and no GNU grep fallback exists.', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(buildUnavailableBackendMessage(error));
    } finally {
      state.settled = true;

      if (autoInstallState === state) {
        autoInstallState = null;
      }
    }
  })();
  // A waiter may stop observing the shared promise as soon as its own signal
  // aborts. Keep the shared rejection handled until every waiter is released.
  void state.promise.catch(() => undefined);

  return state;
}

export async function resolveGrepCliWithAutoInstall(
  deps: GrepResolverDependencies = {},
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  if (signal?.aborted) {
    throw new AbortWaitError('Search was cancelled before execution started.');
  }

  const current = await resolveAsync(deps, signal);
  if (isResolvedRipgrep(current)) {
    return current;
  }

  if (autoInstallState) {
    return waitForSharedAutoInstall(autoInstallState, signal);
  }

  autoInstallState = createSharedAutoInstall(deps);

  return waitForSharedAutoInstall(autoInstallState, signal);
}

export function resetGrepCliResolverForTests(): void {
  autoInstallState = null;
}

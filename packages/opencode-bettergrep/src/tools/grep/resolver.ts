import { statSync } from 'node:fs';
import {
  defaultFindExecutable,
  defaultIsSupportedGrep,
  defaultIsSupportedRipgrep,
  isSupportedVersion,
  probeExecutable,
  raceWithAbort,
} from './cli-probe';
import { GREP_BINARY, RG_BINARY } from './constants';
import { installLatestStableRipgrep } from './downloader';
import {
  getInstalledRipgrepPath,
  getInstalledRipgrepPathAsync,
  getRipgrepCacheDir,
} from './rg-cache';
import {
  AbortWaitError,
  createSearchAbortError,
  getAbortKind,
} from './runtime';
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
}

const DEFAULT_DEPS: GrepResolverDependencies = {};
interface MemoizedCli {
  cli: ResolvedGrepCli;
  pathEnv: string | undefined;
  cacheDir: string;
  stamp: string;
  rgStamp?: string;
  createdAt: number;
}
let cliMemo = new WeakMap<GrepResolverDependencies, MemoizedCli>();
export const AUTO_INSTALL_RETRY_AFTER_MS = 10 * 60_000;
export const AUTO_INSTALL_TIMEOUT_MS = 30_000;
let failedInstallRetryAfter = new WeakMap<GrepResolverDependencies, number>();

function statStamp(binaryPath: string): string | undefined {
  try {
    const stat = statSync(binaryPath);
    return stat.isFile()
      ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`
      : undefined;
  } catch {
    return undefined;
  }
}

function rememberCli(
  deps: GrepResolverDependencies,
  cli: ResolvedGrepCli,
  rgStamp?: string,
): ResolvedGrepCli {
  if (cli.source !== 'missing-rg') {
    const stamp = statStamp(cli.path);
    if (stamp)
      cliMemo.set(deps, {
        cli,
        stamp,
        rgStamp,
        createdAt: Date.now(),
        pathEnv: process.env.PATH,
        cacheDir: getRipgrepCacheDir(),
      });
  }
  return cli;
}

export function invalidateGrepCliResolverCache(): void {
  cliMemo = new WeakMap();
  failedInstallRetryAfter = new WeakMap();
}

interface SharedAutoInstallState {
  promise: Promise<ResolvedGrepCli>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

let autoInstallState: SharedAutoInstallState | null = null;

function buildUnavailableBackendMessage(error?: unknown): string {
  return `Neither ripgrep (rg) nor GNU grep is available. Checked system rg, managed rg, ripgrep auto-install, and system grep.${error instanceof Error && error.message ? ` Auto-install error: ${error.message}` : ''}`;
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof AbortWaitError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function resolvedCli(
  path: string,
  source: ResolvedGrepCli['source'],
): ResolvedGrepCli {
  return {
    path,
    source,
    backend: source === 'system-gnu-grep' ? 'grep' : 'rg',
  };
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
    return resolvedCli(systemRg, 'system-rg');
  }

  const managedRg = getManagedRipgrepPath();
  if (managedRg) return resolvedCli(managedRg, 'managed-rg');

  const systemGrep = findExecutable(GREP_BINARY);
  if (systemGrep && isSupportedGrep(systemGrep)) {
    return resolvedCli(systemGrep, 'system-gnu-grep');
  }

  return resolvedCli(RG_BINARY, 'missing-rg');
}

async function supportsBinary(
  binary: string,
  kind: 'rg' | 'grep',
  override: ((path: string) => boolean) | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (override) return override(binary) === true;
  const probe = await probeExecutable(binary, ['--version'], signal);
  if (probe.timedOut || probe.exitCode !== 0) return false;
  return isSupportedVersion(kind, probe.stdout, probe.stderr);
}

async function resolveAsync(
  deps: GrepResolverDependencies = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  if (signal?.aborted) throw createSearchAbortError();
  const findExecutable = deps.findExecutable ?? defaultFindExecutable;
  const memo = cliMemo.get(deps);
  if (memo) {
    // GNU stays memoized only while the rejected rg candidate is unchanged
    // and the rejection is younger than the negative-cache TTL.
    if (
      memo.pathEnv === process.env.PATH &&
      memo.cacheDir === getRipgrepCacheDir() &&
      statStamp(memo.cli.path) === memo.stamp &&
      (memo.cli.backend === 'rg' ||
        (memo.rgStamp === statStamp(findExecutable(RG_BINARY) ?? '') &&
          Date.now() - memo.createdAt < AUTO_INSTALL_RETRY_AFTER_MS))
    ) {
      return memo.cli;
    }
    cliMemo.delete(deps);
  }
  const systemRg = findExecutable(RG_BINARY);
  if (
    systemRg &&
    (await supportsBinary(systemRg, 'rg', deps.isSupportedRipgrep, signal))
  ) {
    return rememberCli(deps, resolvedCli(systemRg, 'system-rg'));
  }

  const managedRg = deps.getInstalledRipgrepPathAsync
    ? await deps.getInstalledRipgrepPathAsync(signal)
    : deps.getInstalledRipgrepPath
      ? deps.getInstalledRipgrepPath()
      : await getInstalledRipgrepPathAsync(signal);
  if (managedRg) {
    return rememberCli(deps, resolvedCli(managedRg, 'managed-rg'));
  }

  const systemGrep = findExecutable(GREP_BINARY);
  if (
    systemGrep &&
    (await supportsBinary(systemGrep, 'grep', deps.isSupportedGrep, signal))
  ) {
    return rememberCli(
      deps,
      resolvedCli(systemGrep, 'system-gnu-grep'),
      statStamp(systemRg ?? ''),
    );
  }

  return resolvedCli(RG_BINARY, 'missing-rg');
}

export function resolveGrepCli(
  deps: GrepResolverDependencies = {},
): ResolvedGrepCli {
  return resolveSync(deps);
}

function waitForSharedAutoInstall(
  state: SharedAutoInstallState,
  deps: GrepResolverDependencies,
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  state.waiters += 1;

  return raceWithAbort(state.promise, signal).finally(() => {
    state.waiters = Math.max(0, state.waiters - 1);
    if (state.waiters > 0 || state.settled) return;
    if (
      signal?.aborted &&
      (getAbortKind(signal) === 'timeout' ||
        (signal.reason as { name?: unknown } | undefined)?.name ===
          'TimeoutError')
    ) {
      failedInstallRetryAfter.set(
        deps,
        Date.now() + AUTO_INSTALL_RETRY_AFTER_MS,
      );
    }
    if (autoInstallState === state) autoInstallState = null;
    state.controller.abort();
  });
}

function createSharedAutoInstall(
  deps: GrepResolverDependencies,
): SharedAutoInstallState {
  const installManagedRipgrep =
    deps.installLatestStableRipgrep ?? installLatestStableRipgrep;
  const controller = new AbortController();
  const installController = new AbortController();
  const abortInstall = () => installController.abort();
  controller.signal.addEventListener('abort', abortInstall, { once: true });
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const state: SharedAutoInstallState = {
    controller,
    waiters: 0,
    settled: false,
    promise: Promise.resolve(resolvedCli(RG_BINARY, 'missing-rg')),
  };

  state.promise = (async () => {
    try {
      const deadline = new Promise<never>((_, reject) => {
        installTimer = setTimeout(() => {
          timedOut = true;
          installController.abort();
          reject(
            new Error(
              `ripgrep auto-install timed out after ${AUTO_INSTALL_TIMEOUT_MS}ms`,
            ),
          );
        }, AUTO_INSTALL_TIMEOUT_MS);
      });
      const installedPath = await raceWithAbort(
        Promise.race([
          installManagedRipgrep(installController.signal),
          deadline,
        ]),
        controller.signal,
      );
      // A previously memoized GNU fallback must not shadow a new managed rg.
      cliMemo.delete(deps);
      failedInstallRetryAfter.delete(deps);
      return rememberCli(deps, resolvedCli(installedPath, 'managed-rg'));
    } catch (error) {
      if (controller.signal.aborted || (!timedOut && isAbortLikeError(error))) {
        throw createSearchAbortError();
      }

      const fallback = await resolveAsync(deps, controller.signal);
      if (fallback.backend === 'grep') {
        failedInstallRetryAfter.set(
          deps,
          Date.now() + AUTO_INSTALL_RETRY_AFTER_MS,
        );
        return fallback;
      }

      throw new Error(buildUnavailableBackendMessage(error));
    } finally {
      clearTimeout(installTimer);
      controller.signal.removeEventListener('abort', abortInstall);
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
  deps: GrepResolverDependencies = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<ResolvedGrepCli> {
  const current = await resolveAsync(deps, signal);
  if (current.backend === 'rg' && current.source !== 'missing-rg') {
    failedInstallRetryAfter.delete(deps);
    return current;
  }

  if (
    current.backend === 'grep' &&
    (failedInstallRetryAfter.get(deps) ?? 0) > Date.now()
  ) {
    return current;
  }

  autoInstallState ??= createSharedAutoInstall(deps);
  return waitForSharedAutoInstall(autoInstallState, deps, signal);
}

export function resetGrepCliResolverForTests(): void {
  autoInstallState = null;
  invalidateGrepCliResolverCache();
}

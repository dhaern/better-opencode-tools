import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { lock } from 'proper-lockfile';
import { raceSignal, throwIfAborted } from '../../utils/abort';
import { InvalidCachedBinaryError, writeMetadataFile } from './install-io';
import {
  type InstalledRipgrepMetadata,
  validateCachedBinaryAsync,
} from './rg-cache';

// Lock only during publication; release late acquisitions after abort.
const LOCK_STALE_MS = 60_000;
const INSTALL_ORPHAN_STALE_MS = 24 * 60 * 60 * 1_000;

async function withInstallLock<T>(
  dir: string,
  fn: (signal: AbortSignal, canonicalDir: string) => Promise<T>,
  signal?: AbortSignal,
  acquireLock?: typeof lock,
): Promise<T> {
  throwIfAborted(signal);
  await mkdir(dir, { recursive: true });
  throwIfAborted(signal);

  // Lock and publish through the same canonical directory identity. A
  // lexical alias may otherwise create a different `.lock` path for the
  // same physical cache.
  const canonicalDir = await realpath(dir);
  throwIfAborted(signal);
  const compromised = new AbortController();
  const operationSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    compromised.signal,
  ]);

  const lockFile = acquireLock ?? (await import('proper-lockfile')).lock;
  const acquired = lockFile(canonicalDir, {
    stale: LOCK_STALE_MS,
    update: Math.floor(LOCK_STALE_MS / 2),
    retries: { retries: 60, factor: 1, minTimeout: 100, maxTimeout: 250 },
    realpath: true,
    onCompromised: (error) => {
      if (!compromised.signal.aborted) compromised.abort(error);
    },
  });

  let release: () => Promise<void>;
  try {
    release = await raceSignal(acquired, operationSignal);
  } catch (error) {
    // The acquisition may still complete after the race was lost; release
    // it so the lock is not held by a dead waiter.
    acquired.then(
      (rel: () => Promise<void>) => {
        rel().catch(() => undefined);
      },
      () => undefined,
    );
    throw error;
  }

  try {
    throwIfAborted(operationSignal);
    const result = await fn(operationSignal, canonicalDir);
    throwIfAborted(operationSignal);
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}

export interface PublishStagedBinaryInput {
  dir: string;
  final: string;
  metadata: string;
  staged: string;
  version: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
  /** Test seam for exercising cancellation during the metadata write. */
  writeMetadata?: (file: string, contents: string) => Promise<void>;
  /** Test seam for deterministic lock compromise reporting. */
  acquireLock?: typeof lock;
}

/**
 * Publishes a staged binary under the cross-process install lock. An
 * existing INVALID cache is repaired here — under the lock — instead of
 * being left behind to block publication. Exported for deterministic
 * concurrency/abort testing without network access.
 */
export async function publishStagedBinary(
  input: PublishStagedBinaryInput,
  signal?: AbortSignal,
): Promise<void> {
  const { dir } = input;

  await withInstallLock(
    dir,
    async (lockSignal, canonicalDir) => {
      const final = join(canonicalDir, basename(input.final));
      const metadata = join(canonicalDir, basename(input.metadata));
      const stagedDir = await realpath(dirname(input.staged));
      const staged = join(stagedDir, basename(input.staged));
      throwIfAborted(lockSignal);
      // Only the lock holder recovers abandoned attempts, including the old
      // fixed-name temporary. New attempts never reuse a predecessor's path.
      const temporaryPrefix = `${basename(metadata)}.tmp`;
      const staleBefore = Date.now() - LOCK_STALE_MS;
      const installStaleBefore = Date.now() - INSTALL_ORPHAN_STALE_MS;
      for (const entry of await readdir(canonicalDir)) {
        throwIfAborted(lockSignal);
        const metadataTemporary =
          entry === temporaryPrefix ||
          (entry.startsWith(`${temporaryPrefix}-`) &&
            /^[0-9a-f-]{36}$/.test(entry.slice(temporaryPrefix.length + 1)));
        const installTemporary = /^\.install-\d+-[0-9a-z]{1,6}$/.test(entry);
        if (!metadataTemporary && !installTemporary) continue;
        const orphan = join(canonicalDir, entry);
        try {
          const details = installTemporary
            ? await lstat(orphan)
            : await stat(orphan);
          if (
            installTemporary
              ? details.isDirectory() && details.mtimeMs <= installStaleBefore
              : details.mtimeMs <= staleBefore
          ) {
            await rm(orphan, { force: true, recursive: installTemporary });
          }
        } catch {
          // A concurrent cleanup may have removed it already.
        }
      }
      throwIfAborted(lockSignal);
      const existingValid = await (async () => {
        try {
          await validateCachedBinaryAsync(final, lockSignal, metadata);
          return true;
        } catch (error) {
          throwIfAborted(lockSignal);
          if (error instanceof InvalidCachedBinaryError) return false;
          throw error;
        }
      })();
      throwIfAborted(lockSignal);

      if (!existingValid) {
        const temporary = `${metadata}.tmp-${randomUUID()}`;
        // Remove the invalid remnants first so a crash between the two
        // renames leaves no binary-without-metadata combination.
        try {
          await rm(final, { force: true });
          throwIfAborted(lockSignal);
          await rm(metadata, { force: true });
          throwIfAborted(lockSignal);
          // Metadata first, binary second: a reader that sees the binary can
          // always find matching metadata; readers are non-destructive, so
          // intermediate states just read as "not installed".
          const writeMetadata =
            input.writeMetadata ??
            ((file, contents) => writeMetadataFile(file, contents, lockSignal));
          await writeMetadata(
            temporary,
            JSON.stringify({
              version: input.version,
              assetName: input.assetName,
              archiveSha256: input.archiveSha256,
              binarySha256: input.binarySha256,
            } satisfies InstalledRipgrepMetadata),
          );
          // The abort race lands exactly here: a signal fired while the
          // metadata write was pending must stop publication before the
          // first rename makes anything visible.
          throwIfAborted(lockSignal);
          await rename(temporary, metadata);
          throwIfAborted(lockSignal);
          await rename(staged, final);
          throwIfAborted(lockSignal);
        } finally {
          // Never clean shared paths here: after compromise they may belong
          // to a successor. Partial publication is repaired under its lock.
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
    },
    signal,
    input.acquireLock,
  );
}

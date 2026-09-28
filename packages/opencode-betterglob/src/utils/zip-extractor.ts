import { release } from 'node:os';
import { createAbortError } from './abort';
import { isMissingExecutableError, runProcess } from './process-output';
import { isSupervisorError } from './process-supervisor';

const WINDOWS_BUILD_WITH_TAR = 17134;

function getWindowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;
  const build = Number.parseInt(release().split('.')[2] ?? '', 10);
  return Number.isNaN(build) ? null : build;
}

const escapePowerShellPath = (file: string) => file.replace(/'/g, "''");

type WindowsZipExtractor = 'tar' | 'pwsh' | 'powershell';

export async function commandSucceeds(
  command: string,
  args: string[] = ['--version'],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw createAbortError();

  try {
    const result = await runProcess(
      [command, ...args],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        killGraceMs: 250,
        postCloseDrainMs: 250,
      },
      signal,
    );
    if (signal?.aborted) throw createAbortError();
    return !result.aborted && result.exitCode === 0;
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    if (isSupervisorError(error)) throw error;
    if (isMissingExecutableError(error)) return false;
    throw error;
  }
}

async function getWindowsZipExtractorAsync(
  signal?: AbortSignal,
): Promise<WindowsZipExtractor> {
  if (signal?.aborted) throw createAbortError();
  const build = getWindowsBuildNumber();

  if (build !== null && build >= WINDOWS_BUILD_WITH_TAR) return 'tar';
  if (await commandSucceeds('pwsh', ['-v'], signal)) return 'pwsh';
  return 'powershell';
}

export async function getZipExtractionSupportErrorAsync(
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) throw createAbortError();
  if (process.platform === 'win32') {
    const extractor = await getWindowsZipExtractorAsync(signal);
    const args =
      extractor === 'tar'
        ? ['--version']
        : extractor === 'pwsh'
          ? ['-v']
          : ['-Command', '$PSVersionTable.PSVersion.ToString()'];
    if (await commandSucceeds(extractor, args, signal)) return undefined;
    return extractor === 'tar'
      ? 'ripgrep auto-install requires tar on this Windows host to extract zip archives.'
      : extractor === 'pwsh'
        ? 'ripgrep auto-install requires pwsh to extract zip archives on this Windows host.'
        : 'ripgrep auto-install requires PowerShell to extract zip archives on this Windows host.';
  }

  return (await commandSucceeds('unzip', ['-v'], signal))
    ? undefined
    : 'ripgrep auto-install requires unzip to extract zip archives.';
}

export async function extractZip(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw createAbortError();

  const proc = await (async () => {
    if (process.platform !== 'win32') {
      return ['unzip', '-o', archivePath, '-d', destDir];
    }

    const extractor = await getWindowsZipExtractorAsync(signal);
    if (signal?.aborted) throw createAbortError();
    if (extractor === 'tar') {
      return ['tar', '-xf', archivePath, '-C', destDir];
    }

    const command = extractor === 'pwsh' ? 'pwsh' : 'powershell';
    return [
      command,
      '-Command',
      `Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
    ];
  })();

  const { exitCode, stderr } = await runProcess(
    proc,
    { stdout: 'ignore', stderr: 'pipe' },
    signal,
  );

  if (signal?.aborted) throw createAbortError();

  if (exitCode !== 0) {
    throw new Error(`zip extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

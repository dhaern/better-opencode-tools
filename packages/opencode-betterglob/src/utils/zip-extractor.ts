import { release } from 'node:os';
import {
  crossSpawn,
  isMissingExecutableError,
  waitForProcessOutputWithAbortGrace,
} from './compat';
import { isSupervisorError } from './process-supervisor';

const WINDOWS_BUILD_WITH_TAR = 17134;

function getWindowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;

  const parts = release().split('.');
  if (parts.length >= 3) {
    const build = Number.parseInt(parts[2] ?? '', 10);
    if (!Number.isNaN(build)) return build;
  }
  return null;
}

function escapePowerShellPath(file: string): string {
  return file.replace(/'/g, "''");
}

type WindowsZipExtractor = 'tar' | 'pwsh' | 'powershell';

export async function commandSucceeds(
  command: string,
  args: string[] = ['--version'],
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw createAbortError();

  try {
    const proc = crossSpawn([command, ...args], {
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
      signal,
      stdoutPromise,
      { killGraceMs: 250, postCloseDrainMs: 250 },
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

    if (
      extractor === 'tar' &&
      !(await commandSucceeds('tar', ['--version'], signal))
    ) {
      return 'ripgrep auto-install requires tar on this Windows host to extract zip archives.';
    }

    if (
      extractor === 'pwsh' &&
      !(await commandSucceeds('pwsh', ['-v'], signal))
    ) {
      return 'ripgrep auto-install requires pwsh to extract zip archives on this Windows host.';
    }

    if (
      extractor === 'powershell' &&
      !(await commandSucceeds(
        'powershell',
        ['-Command', '$PSVersionTable.PSVersion.ToString()'],
        signal,
      ))
    ) {
      return 'ripgrep auto-install requires PowerShell to extract zip archives on this Windows host.';
    }

    return undefined;
  }

  return (await commandSucceeds('unzip', ['-v'], signal))
    ? undefined
    : 'ripgrep auto-install requires unzip to extract zip archives.';
}

function createAbortError(): Error {
  const error = new Error('ripgrep auto-install was aborted');
  error.name = 'AbortError';
  return error;
}

export async function extractZip(
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw createAbortError();

  const proc = await (async () => {
    if (process.platform !== 'win32') {
      return crossSpawn(['unzip', '-o', archivePath, '-d', destDir], {
        stdout: 'ignore',
        stderr: 'pipe',
        detached: true,
        killProcessGroup: true,
      });
    }

    const extractor = await getWindowsZipExtractorAsync(signal);
    if (signal?.aborted) throw createAbortError();
    if (extractor === 'tar') {
      return crossSpawn(['tar', '-xf', archivePath, '-C', destDir], {
        stdout: 'ignore',
        stderr: 'pipe',
        detached: false,
        killProcessGroup: false,
      });
    }

    const command = extractor === 'pwsh' ? 'pwsh' : 'powershell';
    return crossSpawn(
      [
        command,
        '-Command',
        `Expand-Archive -Path '${escapePowerShellPath(archivePath)}' -DestinationPath '${escapePowerShellPath(destDir)}' -Force`,
      ],
      {
        stdout: 'ignore',
        stderr: 'pipe',
        detached: false,
        killProcessGroup: false,
      },
    );
  })();

  const stderrPromise = proc.stderr();
  const { exitCode, stderr } = await waitForProcessOutputWithAbortGrace(
    proc,
    stderrPromise,
    signal,
  );

  if (signal?.aborted) throw createAbortError();

  if (exitCode !== 0) {
    throw new Error(`zip extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

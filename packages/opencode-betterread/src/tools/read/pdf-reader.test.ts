/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPdf, runCommand } from './pdf-reader';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalPdfInfoOutput = process.env.BETTERREAD_PDFINFO_OUTPUT;
const originalPdfInfoError = process.env.BETTERREAD_PDFINFO_ERROR;
const originalPdfInfoStdoutBytes = process.env.BETTERREAD_PDFINFO_STDOUT_BYTES;
const originalPdfInfoStderrBytes = process.env.BETTERREAD_PDFINFO_STDERR_BYTES;
const originalPdfInfoExitCode = process.env.BETTERREAD_PDFINFO_EXIT_CODE;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'betterread-pdf-'));
  tempDirs.push(directory);
  return directory;
}

async function installPdfMocks(directory: string): Promise<void> {
  const binDirectory = path.join(directory, 'bin');
  await mkdir(binDirectory, { recursive: true });

  const pdfInfoPath = path.join(binDirectory, 'pdfinfo');
  await writeFile(
    pdfInfoPath,
    `#!/usr/bin/env node
const stdout = process.env.BETTERREAD_PDFINFO_OUTPUT || '';
const stderr = process.env.BETTERREAD_PDFINFO_ERROR || '';
const stdoutBytes = Number(process.env.BETTERREAD_PDFINFO_STDOUT_BYTES || '0');
const stderrBytes = Number(process.env.BETTERREAD_PDFINFO_STDERR_BYTES || '0');
process.stdout.write(stdout);
if (stdoutBytes > 0) process.stdout.write('x'.repeat(stdoutBytes));
process.stderr.write(stderr);
if (stderrBytes > 0) process.stderr.write('y'.repeat(stderrBytes));
process.exit(Number(process.env.BETTERREAD_PDFINFO_EXIT_CODE || '0'));
`,
    'utf8',
  );
  await chmod(pdfInfoPath, 0o755);

  process.env.PATH = `${binDirectory}:${originalPath ?? ''}`;
  process.env.BETTERREAD_PDFINFO_OUTPUT = 'Pages: 4\n';
}

async function createPdfFile(directory: string): Promise<string> {
  const filePath = path.join(directory, 'sample.pdf');
  await writeFile(filePath, '%PDF-1.4\n', 'utf8');
  return filePath;
}

afterEach(async () => {
  restoreEnv('PATH', originalPath);
  restoreEnv('BETTERREAD_PDFINFO_OUTPUT', originalPdfInfoOutput);
  restoreEnv('BETTERREAD_PDFINFO_ERROR', originalPdfInfoError);
  restoreEnv('BETTERREAD_PDFINFO_STDOUT_BYTES', originalPdfInfoStdoutBytes);
  restoreEnv('BETTERREAD_PDFINFO_STDERR_BYTES', originalPdfInfoStderrBytes);
  restoreEnv('BETTERREAD_PDFINFO_EXIT_CODE', originalPdfInfoExitCode);

  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('readPdf', () => {
  test('returns attachment-only metadata with page count when available', async () => {
    const directory = await createWorkspace();
    await installPdfMocks(directory);
    const filePath = await createPdfFile(directory);

    const result = await readPdf(filePath);

    expect(result.pageCount).toBe(4);
  });

  test('does not require pdfinfo to return a stable attachment-only result', async () => {
    const directory = await createWorkspace();
    await installPdfMocks(directory);
    const filePath = await createPdfFile(directory);
    process.env.BETTERREAD_PDFINFO_OUTPUT = '';

    const result = await readPdf(filePath);

    expect(result.pageCount).toBeUndefined();
  });

  test('keeps page count parsing with pathological trailing stdout', async () => {
    const directory = await createWorkspace();
    await installPdfMocks(directory);
    const filePath = await createPdfFile(directory);
    process.env.BETTERREAD_PDFINFO_OUTPUT = 'Pages: 7\n';
    process.env.BETTERREAD_PDFINFO_STDOUT_BYTES = String(512 * 1024);

    const result = await readPdf(filePath);

    expect(result.pageCount).toBe(7);
  });

  test('caps stderr buffering from failed pdfinfo commands', async () => {
    const directory = await createWorkspace();
    await installPdfMocks(directory);
    const filePath = await createPdfFile(directory);
    process.env.BETTERREAD_PDFINFO_OUTPUT = '';
    process.env.BETTERREAD_PDFINFO_ERROR = 'boom\n';
    process.env.BETTERREAD_PDFINFO_STDERR_BYTES = String(512 * 1024);
    process.env.BETTERREAD_PDFINFO_EXIT_CODE = '1';

    let caught: unknown;
    try {
      await runCommand('pdfinfo', [filePath]);
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error | undefined)?.message ?? '';
    expect(message).toContain('boom');
    expect(message).toContain('[output truncated]');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(70 * 1024);
  });

  test('cleans up the timeout when spawning the helper command fails', async () => {
    const originalClearTimeout = globalThis.clearTimeout;
    let clearTimeoutCalls = 0;

    globalThis.clearTimeout = ((
      timeout: Parameters<typeof clearTimeout>[0],
    ) => {
      clearTimeoutCalls += 1;
      return originalClearTimeout(timeout);
    }) as typeof clearTimeout;

    try {
      await expect(
        runCommand('definitely-missing-betterread-pdfinfo', []),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }

    expect(clearTimeoutCalls).toBeGreaterThan(0);
  });
});

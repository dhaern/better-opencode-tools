import { spawn } from 'node:child_process';
import { PDF_COMMAND_TIMEOUT_MS } from './constants';
import type { PdfReadResult } from './types';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

// Runs a helper command and resolves with its stdout (capped). Failures only
// ever surface as "metadata unavailable", so stderr is not collected.
export function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    };
    const settle = (error: Error | undefined, value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => {
      kill();
      settle(new Error(`${command} aborted`));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, PDF_COMMAND_TIMEOUT_MS);
    timer.unref();

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const kept = chunk.subarray(0, MAX_COMMAND_OUTPUT_BYTES - size);
      chunks.push(kept);
      size += kept.length;
    });
    child.on('error', (error) => settle(error));
    child.on('close', (code) => {
      if (timedOut) settle(new Error(`${command} timed out`));
      else if (code !== 0) settle(new Error(`${command} failed`));
      else settle(undefined, Buffer.concat(chunks, size).toString('utf8'));
    });
  });
}

export async function readPdf(
  resolvedPath: string,
  signal?: AbortSignal,
): Promise<PdfReadResult> {
  signal?.throwIfAborted();
  let pageCountText: string | undefined;
  try {
    pageCountText = await runCommand('pdfinfo', [resolvedPath], signal);
  } catch {
    // Page count is optional metadata; cancellation is rethrown below.
  }
  signal?.throwIfAborted();
  const pageCount = pageCountText?.match(/^Pages:\s+(\d+)/m)?.[1];
  return {
    kind: 'pdf',
    path: resolvedPath,
    pageCount: pageCount ? Number(pageCount) : undefined,
  };
}

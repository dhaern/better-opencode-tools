import { spawn } from 'node:child_process';
import { PDF_COMMAND_TIMEOUT_MS } from './constants';
import type { PdfReadResult } from './types';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

interface BufferedOutput {
  chunks: Buffer[];
  size: number;
}

function appendOutput(output: BufferedOutput, chunk: Buffer): void {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - output.size;
  if (remaining <= 0) return;

  if (chunk.byteLength > remaining) {
    output.chunks.push(chunk.subarray(0, remaining));
    output.size += remaining;
    return;
  }

  output.chunks.push(chunk);
  output.size += chunk.byteLength;
}

function outputText(output: BufferedOutput): string {
  return Buffer.concat(output.chunks, output.size).toString('utf8');
}

export function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const stdout: BufferedOutput = { chunks: [], size: 0 };
    let timedOut = false;
    let settled = false;

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    function rejectOnce(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function resolveOnce(value: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function onAbort(): void {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
      rejectOnce(new Error(`${command} aborted`));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, PDF_COMMAND_TIMEOUT_MS);
    timer.unref();

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => appendOutput(stdout, chunk));
    child.on('error', (error) => {
      rejectOnce(error);
    });
    child.on('close', (code) => {
      if (settled) return;

      if (timedOut) {
        rejectOnce(new Error(`${command} timed out`));
        return;
      }
      if (code !== 0) {
        rejectOnce(new Error(`${command} failed`));
        return;
      }
      resolveOnce(outputText(stdout));
    });
  });
}

async function tryRun(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await runCommand(command, args, signal);
  } catch {
    // Cancellation must propagate; only genuine pdfinfo failures are
    // optional metadata.
    signal?.throwIfAborted();
    return undefined;
  }
}

export async function readPdf(
  resolvedPath: string,
  signal?: AbortSignal,
): Promise<PdfReadResult> {
  signal?.throwIfAborted();
  const pageCountText = await tryRun('pdfinfo', [resolvedPath], signal);
  signal?.throwIfAborted();
  const pageCount = pageCountText?.match(/^Pages:\s+(\d+)/m)?.[1];

  return {
    kind: 'pdf',
    path: resolvedPath,
    pageCount: pageCount ? Number(pageCount) : undefined,
  };
}

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { PDF_COMMAND_TIMEOUT_MS } from './constants';
import type { PdfReadResult } from './types';

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

interface BufferedOutput {
  chunks: Buffer[];
  size: number;
  truncated: boolean;
}

function appendOutput(output: BufferedOutput, chunk: Buffer): void {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - output.size;
  if (remaining <= 0) {
    output.truncated = true;
    return;
  }

  if (chunk.byteLength > remaining) {
    output.chunks.push(chunk.subarray(0, remaining));
    output.size += remaining;
    output.truncated = true;
    return;
  }

  output.chunks.push(chunk);
  output.size += chunk.byteLength;
}

function outputText(output: BufferedOutput): string {
  return Buffer.concat(output.chunks, output.size).toString('utf8');
}

export function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: BufferedOutput = { chunks: [], size: 0, truncated: false };
    const stderr: BufferedOutput = { chunks: [], size: 0, truncated: false };
    let timedOut = false;
    let settled = false;

    function cleanup(): void {
      clearTimeout(timer);
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

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
    }, PDF_COMMAND_TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => appendOutput(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput(stderr, chunk));
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
        const stderrText = outputText(stderr);
        const truncatedSuffix = stderr.truncated ? '\n[output truncated]' : '';
        rejectOnce(
          new Error(
            stderrText
              ? `${stderrText}${truncatedSuffix}`
              : `${command} failed`,
          ),
        );
        return;
      }
      resolveOnce(outputText(stdout));
    });
  });
}

async function tryRun(
  command: string,
  args: string[],
): Promise<string | undefined> {
  try {
    return await runCommand(command, args);
  } catch {
    return undefined;
  }
}

export async function readPdf(resolvedPath: string): Promise<PdfReadResult> {
  const fileStat = await stat(resolvedPath);
  const pageCountText = await tryRun('pdfinfo', [resolvedPath]);
  const pageCount = pageCountText?.match(/^Pages:\s+(\d+)/m)?.[1];

  return {
    kind: 'pdf',
    path: resolvedPath,
    pageCount: pageCount ? Number(pageCount) : undefined,
    mtimeMs: fileStat.mtimeMs,
  };
}

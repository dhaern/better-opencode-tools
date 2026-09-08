/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { crossSpawn, waitForProcessOutputWithAbortGrace } from './compat';

describe('utils/compat', () => {
  test('collects stdout lazily and bounds retained process output', async () => {
    const child = crossSpawn(
      [process.execPath, '-e', "process.stdout.write('x'.repeat(2_000_000))"],
      { stdout: 'pipe', stderr: 'ignore' },
    );

    expect(
      (child.proc.stdout as { readableFlowing?: boolean | null })
        .readableFlowing,
    ).toBe(null);
    const output = await child.stdout();
    await child.exited;

    expect(output.length).toBeLessThan(1_000_050);
    expect(output).toContain('[process output truncated]');
  });

  test('aborted output waits destroy pipes after the cleanup grace', async () => {
    let stdoutDestroyed = false;
    let stderrDestroyed = false;
    const killed: Array<NodeJS.Signals | number | undefined> = [];
    const proc = {
      proc: {
        stdout: {
          destroy: () => {
            stdoutDestroyed = true;
          },
        },
        stderr: {
          destroy: () => {
            stderrDestroyed = true;
          },
        },
      },
      exited: Promise.resolve(0),
      kill: (signal?: NodeJS.Signals | number) => {
        killed.push(signal);
        return true;
      },
      get exitCode() {
        return null;
      },
    } as any;
    const controller = new AbortController();

    const pendingOutput = new Promise<never>(() => undefined);
    const resultPromise = waitForProcessOutputWithAbortGrace(
      proc,
      pendingOutput,
      controller.signal,
    );
    controller.abort();

    expect(await resultPromise).toBe('aborted');
    expect(stdoutDestroyed).toBe(true);
    expect(stderrDestroyed).toBe(true);
    expect(killed).toEqual([undefined]);
  });
});

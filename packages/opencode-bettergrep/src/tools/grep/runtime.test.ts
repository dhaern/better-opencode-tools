/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import {
  attachTerminationHandlers,
  killProcess,
  setAbortKind,
  spawnRipgrep,
} from './runtime';

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnStubbornProcess() {
  return spawnRipgrep(
    [
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    process.cwd(),
  );
}

describe('tools/grep/runtime process termination', () => {
  test('attachTerminationHandlers escalates timeout to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    const termination = attachTerminationHandlers(proc, 20, controller.signal);

    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(true);
    expect(termination.state.cancelled).toBe(false);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('attachTerminationHandlers escalates cancel to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    const termination = attachTerminationHandlers(
      proc,
      5_000,
      controller.signal,
    );

    controller.abort();
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(false);
    expect(termination.state.cancelled).toBe(true);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('attachTerminationHandlers preserves upstream timeout cause on abort', async () => {
    const proc = spawnStubbornProcess();
    const controller = new AbortController();
    setAbortKind(controller.signal, 'timeout');
    const termination = attachTerminationHandlers(
      proc,
      5_000,
      controller.signal,
    );

    controller.abort();
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));
    termination.cleanup();

    expect(termination.state.timedOut).toBe(true);
    expect(termination.state.cancelled).toBe(false);
    expect(isAlive(proc.proc.pid)).toBe(false);
  });

  test('killProcess escalates to kill stubborn child', async () => {
    const proc = spawnStubbornProcess();

    killProcess(proc);
    await proc.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isAlive(proc.proc.pid)).toBe(false);
  });
});

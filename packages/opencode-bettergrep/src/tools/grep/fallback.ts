import { ensureGnuGrep } from './cli-probe';
import { executeMode } from './direct';
import { type BuiltGrepCommand, buildGrepCommand } from './fallback-command';
import { consumeContentOutput } from './fallback-content';
import { collectFileEntries, finishFileListMode } from './fallback-results';
import type { ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  createEmptyResult,
  hasVisibleResults,
} from './result-utils';
import { getAbortKind, toErrorMessage } from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

export async function executeGrepFallback(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
  prepared?: BuiltGrepCommand,
): Promise<GrepSearchResult> {
  const { command, warnings, patternError } =
    prepared ?? buildGrepCommand(input, cli.path);
  const base = {
    ...createEmptyResult(input, command),
    backend: 'grep' as const,
    warnings: [...warnings],
  };
  if (signal.aborted)
    return {
      ...base,
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
    };
  if (patternError) return { ...base, error: patternError };
  const grepError = await ensureGnuGrep(cli.path, signal, input.timeoutMs);
  if (grepError) return { ...base, error: grepError };

  return executeMode(input, signal, cli, {
    command,
    warnings,
    retries: 0,
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
    init: () => ({
      parsed: {
        files: [] as GrepFileMatch[],
        skippedLines: 0,
        limitReached: false,
      },
    }),
    consumeStdout: async (stdout, proc, state) => {
      if (input.outputMode === 'content') {
        state.parsed = await consumeContentOutput(stdout, proc, input);
        return;
      }
      const collected = await collectFileEntries(
        proc,
        input,
        stdout,
        input.outputMode === 'count' ? 'count' : 'files',
        true,
      );
      state.parsed = collected;
    },
    buildResult: (baseResult, state) => {
      const parsed = state.parsed;
      const result = finishFileListMode(
        baseResult,
        parsed.files,
        input,
        parsed.limitReached,
        { sort: true, warnings: [...warnings] },
      );
      if (parsed.skippedLines > 0) {
        result.truncated = true;
        result.warnings.push(
          `GNU grep fallback skipped ${String(parsed.skippedLines)} unparsable output line(s); results may be incomplete.`,
        );
      }
      return result;
    },
    isStopped: (state, termination) =>
      state.parsed.limitReached ||
      termination.timedOut ||
      termination.cancelled,
    finalizeResult: (result, stdoutError, exitError) => {
      const stderr = result.stderr;
      applySuccessfulStderr(result, stderr, result.exitCode);
      if (/binary file.*matches/i.test(stderr)) {
        result.truncated = true;
        if (!hasVisibleResults(result)) {
          result.error =
            'GNU grep fallback cannot display matches inside binary files; rerun with output_mode=files_with_matches or count.';
          return result;
        }
      }
      if ((exitError || stdoutError) && !result.timedOut && !result.cancelled) {
        result.error = toErrorMessage(exitError ?? stdoutError);
        return result;
      }
      if (
        result.warnings.some((warning) =>
          warning.startsWith('GNU grep fallback skipped'),
        ) &&
        !hasVisibleResults(result) &&
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.cancelled
      ) {
        result.error = 'GNU grep fallback produced unparsable output.';
        return result;
      }
      if (
        result.timedOut ||
        result.cancelled ||
        result.limitReached ||
        result.exitCode === 0
      )
        return result;
      if (result.exitCode === 1 && !hasVisibleResults(result) && !result.stderr)
        return result;
      result.error =
        result.stderr || `grep exited with code ${String(result.exitCode)}`;
      return result;
    },
  });
}

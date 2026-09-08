import { ensureGnuGrep } from './fallback-capabilities';
import { buildGrepCommand } from './fallback-command';
import { consumeContentOutput } from './fallback-content';
import {
  consumeCountOutput,
  consumeFilesOutput,
  finalizeFiles,
  sortFiles,
} from './fallback-results';
import { readTextStream } from './json-stream';
import type { ResolvedGrepCli } from './resolver';
import {
  applySuccessfulStderr,
  createEmptyResult,
  getMatchKind,
  hasVisibleResults,
} from './result-utils';
import {
  attachTerminationHandlers,
  createFriendlySpawnError,
  type GrepProcess,
  getAbortKind,
  spawnRipgrep,
  toErrorMessage,
  waitForExitAndStderr,
} from './runtime';
import type {
  GrepFileMatch,
  GrepSearchResult,
  NormalizedGrepInput,
} from './types';

export async function executeGrepFallback(
  input: NormalizedGrepInput,
  signal: AbortSignal,
  cli: ResolvedGrepCli,
): Promise<GrepSearchResult> {
  const {
    command,
    warnings: commandWarnings,
    patternError,
  } = buildGrepCommand(input, cli.path);
  const baseResult = createEmptyResult(input, command);

  if (signal.aborted) {
    return {
      ...baseResult,
      backend: 'grep',
      truncated: true,
      timedOut: getAbortKind(signal) === 'timeout',
      cancelled: getAbortKind(signal) !== 'timeout',
      warnings: [...commandWarnings],
    };
  }

  if (patternError) {
    return {
      ...baseResult,
      backend: 'grep',
      error: patternError,
      warnings: [...commandWarnings],
    };
  }

  const grepError = await ensureGnuGrep(cli.path, signal, input.timeoutMs);
  if (grepError) {
    return {
      ...baseResult,
      backend: 'grep',
      error: grepError,
      warnings: [...commandWarnings],
    };
  }

  let proc: GrepProcess;
  try {
    proc = spawnRipgrep(command, input.cwd, {
      ...process.env,
      LC_ALL: 'C.UTF-8',
    });
  } catch (error) {
    const friendlyMessage = createFriendlySpawnError(error, cli);
    return {
      ...baseResult,
      backend: 'grep',
      error: friendlyMessage || toErrorMessage(error),
      warnings: [...commandWarnings],
    };
  }

  const termination = attachTerminationHandlers(proc, input.timeoutMs, signal);

  try {
    const stdoutStream = proc.proc.stdout ?? undefined;
    const stderrStream = proc.proc.stderr ?? undefined;
    const stderrPromise = readTextStream(stderrStream);
    const stdoutPromise =
      input.outputMode === 'content'
        ? consumeContentOutput(stdoutStream, proc, input)
        : input.outputMode === 'count'
          ? consumeCountOutput(stdoutStream, proc, input)
          : consumeFilesOutput(stdoutStream, proc, input);

    const [stdoutResult, exitResult] = await Promise.allSettled([
      stdoutPromise,
      waitForExitAndStderr(proc, stderrPromise),
    ]);
    const exitCode =
      exitResult.status === 'fulfilled' ? exitResult.value.exitCode : 1;
    const processError =
      exitResult.status === 'fulfilled'
        ? exitResult.value.error
        : toErrorMessage(exitResult.reason);
    const stderr =
      exitResult.status === 'fulfilled' ? exitResult.value.stderr.trim() : '';
    const stdoutError =
      stdoutResult.status === 'rejected'
        ? toErrorMessage(stdoutResult.reason)
        : undefined;
    const parsed =
      stdoutResult.status === 'fulfilled'
        ? stdoutResult.value
        : {
            files: [] as GrepFileMatch[],
            skippedLines: 0,
            limitReached: false,
          };
    const sortedFiles = sortFiles(parsed.files, input);
    const finalized = finalizeFiles(sortedFiles, input);
    // Bounded admission reports its own limit via parsed.limitReached in
    // sorted mode; the final slice cannot detect it (already at capacity).
    const parserLimitReached = parsed.limitReached;
    const warnings = [...commandWarnings];

    if (parsed.skippedLines > 0) {
      warnings.push(
        `GNU grep fallback skipped ${String(parsed.skippedLines)} unparsable output line(s); results may be incomplete.`,
      );
    }

    const result: GrepSearchResult = {
      ...baseResult,
      backend: 'grep',
      files: finalized.files,
      totalMatches: finalized.totalMatches,
      totalFiles: finalized.totalFiles,
      matchKind: getMatchKind(input.outputMode),
      truncated:
        parserLimitReached ||
        finalized.limitReached ||
        termination.state.timedOut ||
        termination.state.cancelled ||
        parsed.skippedLines > 0,
      limitReached: parserLimitReached || finalized.limitReached,
      timedOut: termination.state.timedOut,
      cancelled: termination.state.cancelled,
      exitCode,
      stderr,
      warnings,
    };

    applySuccessfulStderr(result, stderr, exitCode);

    const hasBinaryMatches = /binary file.*matches/i.test(stderr);
    if (hasBinaryMatches) {
      // GNU grep reports binary matches on stderr without parsable records.
      // Preserve text results, but never present the combined result as
      // complete because the binary matches are known to be omitted.
      result.truncated = true;
      if (!hasVisibleResults(result)) {
        result.error =
          'GNU grep fallback cannot display matches inside binary files; rerun with output_mode=files_with_matches or count.';
        return result;
      }
    }

    if (
      (processError || stdoutError) &&
      !result.timedOut &&
      !result.cancelled
    ) {
      result.error = processError ?? stdoutError;
      return result;
    }

    if (
      parsed.skippedLines > 0 &&
      !hasVisibleResults(result) &&
      exitCode === 0 &&
      !result.timedOut &&
      !result.cancelled
    ) {
      result.error = 'GNU grep fallback produced unparsable output.';
      return result;
    }

    if (termination.state.timedOut || termination.state.cancelled) {
      return result;
    }

    if (result.limitReached) {
      return result;
    }

    if (
      exitCode === 0 ||
      (exitCode === 1 && !hasVisibleResults(result) && stderr.length === 0)
    ) {
      return result;
    }

    result.error = result.stderr || `grep exited with code ${String(exitCode)}`;
    return result;
  } finally {
    termination.cleanup();
  }
}

import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { runOpenCodeSideEffect } from '../../utils/opencode-effects';
import {
  GLOB_DESCRIPTION,
  GLOB_TOOL_ID,
  UNSUPPORTED_FOLLOW_SYMLINKS_ERROR,
} from './constants';
import { formatGlobResult } from './format';
import { normalizeGlobInputAsync, resolveGlobScope } from './normalize';
import { type ResolvedGlobCli, resolveGlobCliAsync } from './resolver';
import { runRipgrep } from './runner';
import { globArgsSchema } from './schema';
import {
  askExternalDirectory,
  askRipgrepAutoInstall,
  baseMetadata,
  emit,
  failureMetadata,
  resultMetadata,
  title,
} from './tool-context';
import {
  AutoClock,
  abortReason,
  raceAbort,
  runWithDeadline,
  TIMEOUT_ERROR_MESSAGE,
  timeoutBudget,
  withHumanPause,
} from './tool-deadline';
import type { GlobRunner, GlobToolInput, NormalizedGlobInput } from './types';

interface CreateGlobToolOptions {
  run?: GlobRunner;
  resolveCli?: (
    signal?: AbortSignal,
  ) => ResolvedGlobCli | Promise<ResolvedGlobCli>;
}

export function createGlobTool(
  pluginCtx: PluginInput,
  options: CreateGlobToolOptions = {},
): ToolDefinition {
  const run = options.run ?? runRipgrep;
  const resolveCli =
    options.resolveCli ??
    ((signal?: AbortSignal) => resolveGlobCliAsync({}, signal));
  const argsSchema = globArgsSchema as Parameters<typeof tool>[0]['args'];

  return tool({
    description: GLOB_DESCRIPTION,
    args: argsSchema,
    async execute(args, ctx) {
      const raw = args as unknown as GlobToolInput;
      let input: NormalizedGlobInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
        if (raw.follow_symlinks === true) {
          throw new Error(UNSUPPORTED_FOLLOW_SYMLINKS_ERROR);
        }
        const scope = resolveGlobScope(raw, ctx, pluginCtx);
        stage = 'permission';

        await raceAbort(
          () =>
            runOpenCodeSideEffect(
              ctx.ask({
                permission: GLOB_TOOL_ID,
                patterns: [raw.pattern],
                always: ['*'],
                metadata: {
                  pattern: raw.pattern,
                  path: raw.path,
                  ...baseMetadata(raw, input),
                },
              }),
            ),
          ctx.abort,
        );

        const clock = new AutoClock(timeoutBudget(raw.timeout_ms));
        clock.start();
        const phaseSignal = AbortSignal.any([
          ctx.abort,
          clock.controller.signal,
        ]);

        const preflight = {
          directory: scope.cwd,
          worktree: scope.worktreeRoot,
          searchPath: scope.resolvedPath,
          followSymlinks: false,
        };
        try {
          await withHumanPause(clock, phaseSignal, () =>
            askExternalDirectory(ctx, preflight),
          );

          stage = 'normalize';
          const normalizedInput = await raceAbort(
            () => normalizeGlobInputAsync(raw, ctx, pluginCtx),
            phaseSignal,
          );
          input = normalizedInput;

          if (
            normalizedInput.searchPath !== preflight.searchPath ||
            normalizedInput.worktree !== preflight.worktree
          ) {
            await withHumanPause(clock, phaseSignal, () =>
              askExternalDirectory(ctx, {
                directory: normalizedInput.cwd,
                worktree: normalizedInput.worktree,
                searchPath: normalizedInput.searchPath,
                followSymlinks: false,
              }),
            );
          }

          const cli = await raceAbort(
            () => Promise.resolve(resolveCli(phaseSignal)),
            phaseSignal,
          );
          if (cli.source === 'missing-rg') {
            await withHumanPause(clock, phaseSignal, () =>
              askRipgrepAutoInstall(ctx),
            );
            // Authorization travels with the execution: the resolver refuses
            // to auto-install unless this flag was set after the permission.
            input = { ...normalizedInput, allowAutoInstall: true };
          }

          const remaining = clock.remainingMs();
          if (remaining <= 0 || clock.controller.signal.aborted) {
            throw new Error(TIMEOUT_ERROR_MESSAGE);
          }

          stage = 'execution';
          const executionInput = input;
          if (!executionInput) {
            throw new Error('glob search normalization produced no input.');
          }
          // Preparation consumed the clock's budget. Pause it before entering
          // the runner: the runner owns the search deadline, and its bounded
          // cleanup phase must not be mistaken for additional automatic work.
          clock.pause();
          if (clock.controller.signal.aborted) {
            throw abortReason(clock.controller.signal);
          }
          const executionRemaining = clock.remainingMs();
          if (executionRemaining <= 0) {
            throw new Error(TIMEOUT_ERROR_MESSAGE);
          }
          const executionDeadline = new AbortController();
          const executionSignal = AbortSignal.any([
            ctx.abort,
            executionDeadline.signal,
          ]);
          const executionTimer = setTimeout(
            () => {
              const error = new Error(TIMEOUT_ERROR_MESSAGE);
              error.name = 'TimeoutError';
              executionDeadline.abort(error);
            },
            Math.max(1, Math.floor(executionRemaining)),
          );
          executionTimer.unref?.();

          try {
            // The runner's deadline covers its async resolver and rg process;
            // cap it by the remaining automatic budget. runWithDeadline then
            // waits long enough to receive the runner's bounded cleanup result.
            const result = await runWithDeadline(
              () =>
                run(
                  {
                    ...executionInput,
                    timeoutMs: Math.max(1, Math.floor(executionRemaining)),
                  },
                  executionSignal,
                ),
              executionSignal,
            );
            const output = formatGlobResult(executionInput, result);
            const metadata = resultMetadata(raw, executionInput, result);

            await emit(ctx, title(raw, executionInput), metadata);

            // Structured return: the host adapter preserves metadata attached
            // here instead of overwriting it with an empty object.
            return { title: title(raw, executionInput), output, metadata };
          } finally {
            clearTimeout(executionTimer);
          }
        } finally {
          clock.dispose();
        }
      } catch (error) {
        await emit(
          ctx,
          title(raw, input),
          failureMetadata(raw, stage, error, input),
        );
        throw error;
      }
    },
  });
}

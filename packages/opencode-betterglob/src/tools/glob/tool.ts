import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { raceSignal } from '../../utils/abort';
import { runOpenCodeSideEffect } from '../../utils/tool-context';
import { GLOB_DESCRIPTION, GLOB_TOOL_ID } from './constants';
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
} from './tool-adapter';
import {
  AutoClock,
  abortReason,
  RUNNER_ABORT_GRACE_MS,
  raceAbort,
  TIMEOUT_ERROR_MESSAGE,
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
    ((signal?: AbortSignal) => resolveGlobCliAsync(undefined, signal));
  return tool({
    description: GLOB_DESCRIPTION,
    args: globArgsSchema,
    async execute(args, ctx) {
      // Keep the plugin schema boundary explicit; inferring it via satisfies
      // exposes non-portable plugin types (TS2742) in declaration output.
      const raw = args as unknown as GlobToolInput;
      let input: NormalizedGlobInput | undefined;
      let stage: 'normalize' | 'permission' | 'execution' = 'normalize';

      try {
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
                  ...baseMetadata(raw, input),
                },
              }),
            ),
          ctx.abort,
        );

        const clock = new AutoClock(scope.timeoutMs);
        clock.start();
        const phaseSignal = AbortSignal.any([
          ctx.abort,
          clock.controller.signal,
        ]);

        const preflight = {
          directory: scope.cwd,
          worktree: scope.worktreeRoot,
          searchPath: scope.resolvedPath,
        };
        try {
          await withHumanPause(clock, phaseSignal, () =>
            askExternalDirectory(ctx, preflight),
          );

          stage = 'normalize';
          const normalizedInput = await raceAbort(
            () => normalizeGlobInputAsync(raw, ctx, pluginCtx, scope),
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

          const executionInput = input;
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
          const executionClock = new AutoClock(executionRemaining);
          executionClock.start();
          const executionSignal = AbortSignal.any([
            ctx.abort,
            executionClock.controller.signal,
          ]);

          try {
            stage = 'execution';
            // The runner's deadline covers its async resolver and rg process;
            // cap it by the remaining automatic budget. runWithDeadline then
            // waits long enough to receive the runner's bounded cleanup result.
            const result = await raceSignal(
              () =>
                run(
                  {
                    ...executionInput,
                    timeoutMs: Math.max(1, Math.floor(executionRemaining)),
                  },
                  executionSignal,
                ),
              executionSignal,
              { graceMs: RUNNER_ABORT_GRACE_MS, reason: abortReason },
            );
            const output = formatGlobResult(executionInput, result);
            const metadata = resultMetadata(raw, executionInput, result);

            await emit(ctx, title(raw, executionInput), metadata);

            // Structured return: the host adapter preserves metadata attached
            // here instead of overwriting it with an empty object.
            return { title: title(raw, executionInput), output, metadata };
          } finally {
            executionClock.dispose();
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

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from '@opencode/plugin';
import type { Info } from '@opencode/plugin/promise/tool';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';

type Options = {
  args?: ToolDefinition['args'];
  description?: string;
  input?: (input: Record<string, unknown>) => Record<string, unknown>;
  metadata?: (metadata: Record<string, unknown>, output: string) => void;
};

const json = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value));

const slash = (value: string) => value.replaceAll('\\', '/');

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function projectRoot(directory: string): Promise<string> {
  for (let current = directory; ; current = path.dirname(current)) {
    for (const marker of ['.git', '.hg']) {
      try {
        await stat(path.join(current, marker));
        return current;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
        )
          return directory;
      }
    }
    if (path.dirname(current) === current) return directory;
  }
}

export function adaptTool(
  ctx: Plugin.Context,
  name: 'grep' | 'glob' | 'read',
  legacy: ToolDefinition,
  options: Options = {},
): Info {
  const object = tool.schema.object(options.args ?? legacy.args);
  const standard = object['~standard'];
  const inputSchema = tool.schema.toJSONSchema(object, {
    target: 'draft-2020-12',
    io: 'input',
  });
  const outputSchema = tool.schema.toJSONSchema(object, {
    target: 'draft-2020-12',
    io: 'output',
  });
  const { directory } = ctx.location;
  const worktree = ctx.location.project.directory;

  return {
    name,
    description: options.description ?? legacy.description,
    input: {
      '~standard': {
        version: 1,
        vendor: standard.vendor,
        validate: (value: unknown) => standard.validate(value),
        jsonSchema: { input: () => inputSchema, output: () => outputSchema },
      },
    },
    options: { codemode: false },
    async execute(input, toolCtx) {
      const result = await legacy.execute(options.input?.(input) ?? input, {
        sessionID: toolCtx.sessionID,
        messageID: toolCtx.messageID,
        agent: toolCtx.agent,
        directory,
        worktree,
        abort: toolCtx.signal,
        async metadata(update) {
          try {
            await toolCtx.progress(json(update.metadata ?? {}));
          } catch {
            // Progress is best-effort.
          }
        },
        async ask(ask) {
          let resources = ask.patterns;
          let save = ask.always;
          if (ask.permission === 'external_directory') {
            save = await Promise.all(
              ask.patterns.map(async (pattern) =>
                slash(path.join(await projectRoot(path.dirname(pattern)), '*')),
              ),
            );
          } else if (name === 'read' && ask.permission === 'read') {
            const resource = (absolute: string) => {
              const internal =
                contains(directory, absolute) ||
                (worktree !== path.parse(worktree).root &&
                  contains(worktree, absolute));
              return slash(
                internal ? path.relative(directory, absolute) || '.' : absolute,
              );
            };
            const lexical = resource(String(ask.metadata.resolved_path));
            const real = resource(String(ask.metadata.access_path));
            resources = lexical === real ? [lexical] : [lexical, real];
            save = ['*'];
          }
          await ctx.permission.assert({
            sessionID: toolCtx.sessionID,
            agent: toolCtx.agent,
            action: ask.permission,
            resources,
            save,
            metadata: json(ask.metadata),
            source: {
              type: 'tool',
              messageID: toolCtx.messageID,
              id: toolCtx.id,
            },
          });
        },
      });
      const output = typeof result === 'string' ? result : result.output;
      const metadata = typeof result === 'string' ? {} : { ...result.metadata };
      options.metadata?.(metadata, output);
      if (name === 'read') {
        metadata.truncated = Boolean(
          metadata.has_more ||
            metadata.truncated_by_bytes ||
            metadata.truncated_by_line_length,
        );
      } else {
        delete metadata.truncated;
      }
      const attachments =
        typeof result === 'string' ? undefined : result.attachments;
      return {
        content: attachments?.length
          ? [
              { type: 'text' as const, text: output },
              ...attachments.map((attachment) => ({
                type: 'file' as const,
                uri: attachment.url,
                mime: attachment.mime,
                ...(attachment.filename === undefined
                  ? {}
                  : { name: attachment.filename }),
              })),
            ]
          : output,
        metadata: json(metadata),
      };
    },
  };
}

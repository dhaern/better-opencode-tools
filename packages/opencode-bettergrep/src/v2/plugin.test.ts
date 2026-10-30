import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin from '../index';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bettergrep-v2-'));
  dirs.push(dir);
  return dir;
}

async function registered(directory: string, reject?: Error) {
  const asks: any[] = [];
  const progress: any[] = [];
  let registeredTool: any;
  let transforms = 0;
  await (plugin as any).setup({
    location: { directory, project: { directory } },
    options: {},
    permission: {
      assert: async (input: any) => {
        asks.push(input);
        if (reject) throw reject;
      },
    },
    tool: {
      transform: async (fn: any) => {
        transforms++;
        fn({
          add: (tool: any) => {
            registeredTool = tool;
          },
        });
      },
    },
  });
  const toolCtx = {
    sessionID: 'session',
    agent: 'agent',
    messageID: 'message',
    id: 'call',
    signal: new AbortController().signal,
    progress: async (value: any) => {
      progress.push(value);
    },
  };
  return { tool: registeredTool, asks, progress, toolCtx, transforms };
}

test('registers one direct tool with described JSON schema and defaults', async () => {
  const { tool, transforms } = await registered(temp());
  expect(transforms).toBe(1);
  expect(tool.name).toBe('grep');
  expect(tool.options).toEqual({ codemode: false });
  const schema = tool.input['~standard'];
  expect(
    schema.jsonSchema.input({ target: 'draft-2020-12' }).properties.pattern
      .description,
  ).toBe('Regex pattern to search for in file contents.');
  expect(
    schema.jsonSchema.output({ target: 'draft-2020-12' }).properties.pattern
      .description,
  ).toBe('Regex pattern to search for in file contents.');
  expect((await schema.validate({ pattern: 'needle' })).value.output_mode).toBe(
    'content',
  );
});

test('accepts and clamps symmetric context above 50', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, toolCtx } = await registered(dir);
  const input = await tool.input['~standard'].validate({
    pattern: 'needle',
    context: 85,
  });
  expect(input.issues).toBeUndefined();
  expect(input.value.context).toBe(85);
  const result = await tool.execute(input.value, toolCtx);
  expect(result.metadata).toMatchObject({
    context: 50,
    before_context: 50,
    after_context: 50,
  });
  expect(result.metadata.command).toEqual(expect.arrayContaining(['-C', '50']));
});

test('accepts and clamps before context above 50', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, toolCtx } = await registered(dir);
  const input = await tool.input['~standard'].validate({
    pattern: 'needle',
    before_context: 85,
  });
  expect(input.issues).toBeUndefined();
  expect(input.value.before_context).toBe(85);
  const result = await tool.execute(input.value, toolCtx);
  expect(result.metadata.before_context).toBe(50);
  expect(result.metadata.command).toEqual(expect.arrayContaining(['-B', '50']));
});

test('accepts and clamps after context above 50', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, toolCtx } = await registered(dir);
  const input = await tool.input['~standard'].validate({
    pattern: 'needle',
    after_context: 85,
  });
  expect(input.issues).toBeUndefined();
  expect(input.value.after_context).toBe(85);
  const result = await tool.execute(input.value, toolCtx);
  expect(result.metadata.after_context).toBe(50);
  expect(result.metadata.command).toEqual(expect.arrayContaining(['-A', '50']));
});

test('returns JSON-only metadata and grep summary without output or truncated', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, toolCtx } = await registered(dir);
  const result = await tool.execute({ pattern: 'needle' }, toolCtx);
  expect(result.content).toContain('needle');
  expect(result).not.toHaveProperty('output');
  expect(result.metadata).toStrictEqual(
    JSON.parse(JSON.stringify(result.metadata)),
  );
  expect(result.metadata).toMatchObject({
    matches: 1,
    files: 1,
    search_truncated: false,
  });
  expect(result.metadata).not.toHaveProperty('truncated');
});

test('sends JSON-only progress metadata', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, progress, toolCtx } = await registered(dir);
  await tool.execute({ pattern: 'needle' }, toolCtx);
  expect(progress[0]).toStrictEqual(JSON.parse(JSON.stringify(progress[0])));
});

test('maps grep permission requests to v2', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'needle\n');
  const { tool, asks, toolCtx } = await registered(dir);
  await tool.execute({ pattern: 'needle' }, toolCtx);
  expect(asks[0].metadata).toStrictEqual(
    JSON.parse(JSON.stringify(asks[0].metadata)),
  );
  expect(asks[0]).toMatchObject({
    action: 'grep',
    resources: ['needle'],
    save: ['*'],
    sessionID: 'session',
    agent: 'agent',
    source: { type: 'tool', messageID: 'message', id: 'call' },
  });
});

test('saves external directory permission at its project root', async () => {
  const dir = temp();
  const external = temp();
  mkdirSync(path.join(external, '.git'));
  mkdirSync(path.join(external, 'nested'));
  writeFileSync(path.join(external, 'nested', 'sample.txt'), 'needle\n');
  const { tool, asks, toolCtx } = await registered(dir);
  await tool.execute(
    { pattern: 'needle', path: path.join(external, 'nested') },
    toolCtx,
  );
  expect(asks.find((ask) => ask.action === 'external_directory')).toMatchObject(
    {
      resources: [path.join(external, 'nested', '*')],
      save: [path.join(external, '*')],
    },
  );
});

test('preserves the exact permission rejection', async () => {
  const error = new Error('declined');
  const { tool, toolCtx } = await registered(temp(), error);
  expect(
    await tool
      .execute({ pattern: 'needle' }, toolCtx)
      .catch((caught: unknown) => caught),
  ).toBe(error);
});

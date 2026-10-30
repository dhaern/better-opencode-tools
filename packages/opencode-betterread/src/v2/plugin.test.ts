import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import plugin from '../index';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'betterread-v2-'));
  dirs.push(dir);
  return dir;
}

async function registered(
  directory: string,
  options: unknown = {},
  reject?: Error,
  project = directory,
) {
  const asks: any[] = [];
  let registeredTool: any;
  let transforms = 0;
  await (plugin as any).setup({
    location: { directory, project: { directory: project } },
    options,
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
    progress: async () => {},
  };
  return { tool: registeredTool, asks, toolCtx, transforms };
}

test('registers one direct tool with described JSON schema and defaults', async () => {
  const { tool, transforms } = await registered(temp());
  expect(transforms).toBe(1);
  expect(tool.name).toBe('read');
  expect(tool.options).toEqual({ codemode: false });
  expect(tool.description).not.toContain('filePath');
  const schema = tool.input['~standard'];
  expect(
    schema.jsonSchema.input({ target: 'draft-2020-12' }).properties.path
      .description,
  ).toContain('The path to the file');
  expect(
    schema.jsonSchema.output({ target: 'draft-2020-12' }).properties.path
      .description,
  ).toContain('The path to the file');
  expect((await schema.validate({ path: 'sample.txt' })).value.offset).toBe(1);
});

test('returns file parts and JSON-only metadata with boolean truncated', async () => {
  const dir = temp();
  writeFileSync(
    path.join(dir, 'sample.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X+WQAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const { tool, toolCtx } = await registered(dir);
  const result = await tool.execute({ path: 'sample.png' }, toolCtx);
  expect(result).not.toHaveProperty('output');
  expect(result.metadata).toStrictEqual(
    JSON.parse(JSON.stringify(result.metadata)),
  );
  expect(result.metadata.truncated).toBe(false);
  expect(result.content[0]).toMatchObject({ type: 'text' });
  expect(result.content[1]).toMatchObject({
    type: 'file',
    mime: 'image/png',
    name: 'sample.png',
  });
  expect(result.content[1].uri).toStartWith('data:image/png;base64,');
});

test('uses v2 external saves and lexical read resources', async () => {
  const project = temp();
  const dir = path.join(project, 'work');
  mkdirSync(dir);
  writeFileSync(path.join(project, 'sibling.txt'), 'inside');
  const external = temp();
  mkdirSync(path.join(external, '.git'));
  mkdirSync(path.join(external, 'nested'));
  const target = path.join(external, 'nested', 'sample.txt');
  writeFileSync(target, 'outside');
  const { tool, asks, toolCtx } = await registered(dir, {}, undefined, project);
  await tool.execute({ path: '../sibling.txt' }, toolCtx);
  expect(asks.find((ask) => ask.action === 'read')).toMatchObject({
    resources: ['../sibling.txt'],
    save: ['*'],
    source: { type: 'tool', messageID: 'message', id: 'call' },
  });
  asks.length = 0;
  await tool.execute({ path: target }, toolCtx);
  expect(asks.find((ask) => ask.action === 'external_directory')).toMatchObject(
    {
      resources: [path.join(external, 'nested', '*')],
      save: [path.join(external, '*')],
    },
  );
  expect(asks.find((ask) => ask.action === 'read')).toMatchObject({
    resources: [target],
    save: ['*'],
  });
});

test('checks the real path as well as the lexical path for symlink reads', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, '.env'), 'SECRET=value');
  symlinkSync('.env', path.join(dir, 'visible.txt'));
  const { tool, asks, toolCtx } = await registered(dir);
  await tool.execute({ path: 'visible.txt' }, toolCtx);
  expect(asks.find((ask) => ask.action === 'read')).toMatchObject({
    resources: ['visible.txt', '.env'],
    save: ['*'],
  });
});

test('preserves the exact permission rejection', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'hello');
  const error = new Error('declined');
  const { tool, toolCtx } = await registered(dir, {}, error);
  expect(
    await tool
      .execute({ path: 'sample.txt' }, toolCtx)
      .catch((caught: unknown) => caught),
  ).toBe(error);
});

test('maps path to the reader filePath', async () => {
  const dir = temp();
  writeFileSync(path.join(dir, 'sample.txt'), 'hello');
  const { tool, asks, toolCtx } = await registered(dir);
  const result = await tool.execute({ path: 'sample.txt' }, toolCtx);
  expect(result.content).toContain('hello');
  expect(asks[0].metadata.filePath).toBe('sample.txt');
});

test('applies plugin output limits', async () => {
  const dir = temp();
  writeFileSync(
    path.join(dir, 'sample.txt'),
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  const { tool, toolCtx } = await registered(dir, {
    tool_output: { max_lines: 12, max_bytes: 1000 },
  });
  const result = await tool.execute({ path: 'sample.txt' }, toolCtx);
  expect(result.content).toContain('line 1');
  expect(result.content).not.toContain('line 100');
  expect(result.metadata.truncated).toBe(true);
  expect(result.content.split('\n').length).toBeLessThanOrEqual(12);
});

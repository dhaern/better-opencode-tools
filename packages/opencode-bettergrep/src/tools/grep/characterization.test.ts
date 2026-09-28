/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import which from 'which';
import { GrepAggregator } from './aggregate';
import { executeContentLikeMode, executeFileListMode } from './direct';
import { executeGrepFallback } from './fallback';
import { comparePathBytes } from './fallback-results';
import { buildPrimarySummary, formatGrepResult } from './format';
import { executeMtimeMode } from './mtime';
import { normalizeGrepInput } from './normalize';
import { createRepoContext, createTempTracker } from './test-helpers';
import type { GrepBackend, GrepOutputMode, GrepSearchResult } from './types';

const temps = createTempTracker();

async function search(
  root: string,
  backend: GrepBackend,
  mode: GrepOutputMode,
  sortBy: 'none' | 'path' | 'mtime',
  context: number,
  maxResults: number,
  overrides: Record<string, unknown> = {},
): Promise<GrepSearchResult> {
  const input = normalizeGrepInput(
    {
      pattern: 'needle',
      path: root,
      output_mode: mode,
      sort_by: sortBy,
      context,
      max_results: maxResults,
      fixed_strings: true,
      ...overrides,
    },
    createRepoContext(root) as never,
  );
  const signal = new AbortController().signal;
  if (backend === 'grep') {
    return executeGrepFallback(input, signal, {
      path: which.sync('grep', { nothrow: false }),
      backend,
      source: 'system-gnu-grep',
    });
  }
  const cli = {
    path: which.sync('rg', { nothrow: false }),
    backend,
    source: 'system-rg',
  } as const;
  if (sortBy === 'mtime') return executeMtimeMode(input, signal, cli);
  if (mode === 'count') return executeFileListMode(input, signal, cli);
  if (mode === 'files_with_matches')
    return executeFileListMode(input, signal, cli);
  return executeContentLikeMode(input, signal, cli);
}

// Only observable, deterministic fields. Never snapshot timings, temp paths or
// generated commands (which depend on the host's executable location).
function stable(
  result: GrepSearchResult,
  root: string,
  order: 'none' | 'path' | 'mtime' = 'path',
) {
  const relative = (value: string) =>
    value
      .replaceAll(root, '<ROOT>')
      .replace(/bytes:base64:[A-Za-z0-9+/=]+/g, 'bytes:base64:<PATH>');
  const files =
    order === 'none'
      ? [...result.files].sort(comparePathBytes)
      : result.files;
  return {
    backend: result.backend,
    mode: result.outputMode,
    kind: result.matchKind,
    summary: buildPrimarySummary(result),
    files: files.map((file) => ({
      file: relative(file.file),
      path: relative(file.absolutePath),
      nonUtf8Path: file.nonUtf8Path,
      matchCount: file.matchCount,
      matches: file.matches,
    })),
    totalMatches: result.totalMatches,
    totalFiles: result.totalFiles,
    truncated: result.truncated,
    limitReached: result.limitReached,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    exitCode: result.limitReached ? '<early-stop>' : result.exitCode,
    warnings: result.warnings.map(relative),
    error: result.error && relative(result.error),
  };
}

describe('grep observable result characterization', () => {
  test('golden output at the 2000-unit escaped boundary for rg and GNU grep', async () => {
    const root = temps.createRepo();
    const file = path.join(root, 'src', 'boundary.txt');
    const lines = [
      `needle${'a'.repeat(1991)}\t\x01`, // 1999 units
      `needle${'b'.repeat(1992)}\t\x01`, // 2000 units
      `needle${'c'.repeat(1993)}\t\x01`, // 2001 units
      `needle${'d'.repeat(1993)}\t\x01🦊${'e'.repeat(2996)}\r`, // 5000 units
      `needle${'f'.repeat(1993)}🦊`, // surrogate pair crosses the cut
    ];
    expect(lines.slice(0, 4).map((line) => line.length)).toEqual([
      1999, 2000, 2001, 5000,
    ]);
    writeFileSync(file, `${lines.join('\n')}\n`);
    const input = normalizeGrepInput(
      { pattern: 'needle', path: file, fixed_strings: true },
      createRepoContext(root) as never,
    );
    const expected = [
      'Pattern: needle',
      `Path: ${file}`,
      '',
      'Found 5 matches across 1 file.',
      '',
      'src/boundary.txt',
      `      1: needle${'a'.repeat(1991)}\\t\\...`,
      '',
      `      2: needle${'b'.repeat(1992)}\\t...`,
      '',
      `      3: needle${'c'.repeat(1993)}\\...`,
      '',
      `      4: needle${'d'.repeat(1993)}\\...`,
      '',
      `      5: needle${'f'.repeat(1993)}\ud83e...`,
    ].join('\n');
    for (const backend of ['rg', 'grep'] as const) {
      const result = await search(root, backend, 'content', 'none', 0, 500, {
        path: file,
      });
      expect(formatGrepResult(input, { ...result, summary: undefined })).toBe(
        backend === 'grep'
          ? `${expected}\n\n---\nGNU grep fallback does not apply ripgrep ignore rules (gitignore or otherwise); results may include ignored files.`
          : expected,
      );
    }
  });

  test('rg multiline golden normalizes over 2001 CRLF pairs before truncation', () => {
    const root = temps.createRepo();
    const input = normalizeGrepInput(
      { pattern: 'needle', path: 'src' },
      createRepoContext(root) as never,
    );
    const aggregator = new GrepAggregator(input);
    aggregator.consume({
      type: 'match',
      data: {
        path: { text: path.join(root, 'src', 'boundary.txt') },
        line_number: 1,
        lines: { text: 'needle\r\n'.repeat(2002) },
        submatches: [],
      },
    });
    const snapshot = aggregator.snapshot();
    const result: GrepSearchResult = {
      ...snapshot,
      backend: 'rg',
      outputMode: 'content',
      matchKind: 'match',
      truncated: false,
      timedOut: false,
      cancelled: false,
      exitCode: 0,
      retryCount: 0,
      command: [],
      cwd: root,
      stderr: '',
      warnings: [],
    };
    const expected = [
      'Pattern: needle',
      'Path: src',
      '',
      'Found 1 match across 1 file.',
      '',
      'src/boundary.txt',
      `      1: needle${'\n         needle'.repeat(284)}\n         needl...`,
    ].join('\n');
    expect(formatGrepResult(input, result)).toBe(expected);
  });

  function fixture() {
    const root = temps.createRepo();
    const a = path.join(root, 'src', 'a.txt');
    const z = path.join(root, 'src', 'z.txt');
    writeFileSync(a, 'before\nneedle one\nafter\n');
    writeFileSync(z, 'before\nneedle two\nafter\n');
    utimesSync(
      a,
      new Date('2020-01-01T00:00:00Z'),
      new Date('2020-01-01T00:00:00Z'),
    );
    utimesSync(
      z,
      new Date('2021-01-01T00:00:00Z'),
      new Date('2021-01-01T00:00:00Z'),
    );
    return root;
  }

  for (const backend of ['rg', 'grep'] as const) {
    for (const mode of ['content', 'files_with_matches', 'count'] as const) {
      for (const order of ['none', 'path', 'mtime'] as const) {
        for (const context of [0, 2]) {
          for (const maxResults of [1, 20]) {
            test(`${backend}/${mode}/${order}/context=${context}/limit=${maxResults}`, async () => {
              const root = fixture();
              const result = await search(
                root,
                backend,
                mode,
                order,
                context,
                maxResults,
                {
                  ...(order === 'none' && maxResults === 1
                    ? { path: path.join(root, 'src', 'a.txt') }
                    : {}),
                },
              );
              expect(stable(result, root, order)).toMatchSnapshot();
            });
          }
        }
      }
    }
  }

  test('UTF-8, non-UTF8, binary, CRLF and external symlink fixtures', async () => {
    const edges = temps.createRepo();
    const external = temps.createDir('opencode-bettergrep-external');
    writeFileSync(path.join(edges, 'src', 'utf8.txt'), 'café needle\n');
    writeFileSync(path.join(edges, 'src', 'crlf.txt'), 'needle\r\n');
    writeFileSync(
      path.join(edges, 'src', 'binary.dat'),
      Buffer.from('needle\0needle\n'),
    );
    writeFileSync(path.join(external, 'outside.txt'), 'needle external\n');
    symlinkSync(
      path.join(external, 'outside.txt'),
      path.join(edges, 'src', 'link.txt'),
    );
    writeFileSync(
      Buffer.concat([
        Buffer.from(path.join(edges, 'src') + path.sep),
        Buffer.from([0x62, 0x61, 0x64, 0xff]),
      ]),
      'needle invalid path\n',
    );
    for (const backend of ['rg', 'grep'] as const) {
      for (const mode of ['content', 'files_with_matches', 'count'] as const) {
        const result = await search(edges, backend, mode, 'path', 0, 20, {
          follow_symlinks: true,
        });
        expect(
          stable(result, edges).files.map((file) => ({
            ...file,
            path: file.path.replaceAll(external, '<EXTERNAL>'),
            file: file.file.replaceAll(external, '<EXTERNAL>'),
          })),
        ).toMatchSnapshot();
      }
    }
  });
});

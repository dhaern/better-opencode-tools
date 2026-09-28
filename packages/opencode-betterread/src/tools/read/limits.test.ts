/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { hostOutputLimits, normalizeReadArgs } from './limits';

test('rejects fractional and unsafe host output limits', () => {
  expect(
    hostOutputLimits({
      tool_output: { max_lines: 1.5, max_bytes: 2 ** 53 },
    }),
  ).toEqual({ maxLines: 2000, maxBytes: 51_200 });
});

describe('normalizeReadArgs', () => {
  test('applies defaults and clamps invalid values', () => {
    expect(
      normalizeReadArgs({
        filePath: 'foo',
        offset: -4,
        limit: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      filePath: 'foo',
      offset: 1,
      limit: 4096,
    });
  });

  test('returns normalized public read arguments', () => {
    expect(
      normalizeReadArgs({
        filePath: 'bar',
        offset: 2.9,
        limit: 99,
      }),
    ).toEqual({
      filePath: 'bar',
      offset: 2,
      limit: 99,
    });
  });

  test('coerces numeric strings like the native read schema', () => {
    expect(
      normalizeReadArgs({
        filePath: 'baz',
        offset: '10' as unknown as number,
        limit: '25' as unknown as number,
      }),
    ).toEqual({
      filePath: 'baz',
      offset: 10,
      limit: 25,
    });
  });
});

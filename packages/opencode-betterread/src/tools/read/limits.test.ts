/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test';
import { normalizeReadArgs } from './limits';

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

import { describe, expect, it } from 'vitest';
import { err, flatMap, isErr, isOk, map, ok, tryCatch, unwrapOr } from './result';

describe('Result helpers', () => {
  it('creates and narrows ok/err values', () => {
    const success = ok(2);
    const failure = err('bad');
    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isErr(failure)).toBe(true);
    expect(isOk(failure)).toBe(false);
    expect(map(success, (value) => value * 2)).toEqual({ ok: true, value: 4 });
    expect(map(failure, (value: never) => value)).toEqual(failure);
    expect(flatMap(success, (value) => ok(String(value)))).toEqual({ ok: true, value: '2' });
    expect(flatMap(failure, (value: never) => ok(value))).toEqual(failure);
  });

  it('uses eager and lazy fallbacks', () => {
    expect(unwrapOr(ok(3), 0)).toBe(3);
    expect(unwrapOr(err('reason'), 0)).toBe(0);
    expect(unwrapOr(err('reason'), (reason) => reason.length)).toBe(6);
  });

  it('将抛出的未知值转换为 Result', () => {
    expect(
      tryCatch(
        () => 1,
        () => 'error',
      ),
    ).toEqual({ ok: true, value: 1 });
    expect(
      tryCatch(
        () => {
          throw new Error('boom');
        },
        (cause) => (cause instanceof Error ? cause.message : 'unknown'),
      ),
    ).toEqual({
      ok: false,
      error: 'boom',
    });
  });
});

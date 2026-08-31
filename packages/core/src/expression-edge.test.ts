import { ExpressionError } from '@jasw/pro-cell-shared';
import { describe, expect, it, vi } from 'vitest';
import {
  actionDependencies,
  compileExpression,
  evaluateActionValue,
  evaluateExpression,
  isExpressionTemplate,
} from './expression';

describe('expression parser boundaries', () => {
  it('非字符串输入返回 ExpressionError', () => {
    const result = compileExpression(42 as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.expression).toBe('42');
    }
  });

  it('超长或超深表达式返回错误而不是耗尽调用栈', () => {
    for (const source of [
      `${'('.repeat(128)}true${')'.repeat(128)}`,
      `${'!'.repeat(128)}true`,
      'true || '.repeat(1_000) + 'false',
    ]) {
      const result = compileExpression(source);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ExpressionError);
        expect(result.error).not.toBeInstanceOf(RangeError);
      }
    }
  });

  it('将编译器内部异常封装为 ExpressionError', () => {
    const trim = vi.spyOn(String.prototype, 'trim').mockImplementationOnce(() => {
      throw new RangeError('synthetic compiler failure');
    });
    const result = compileExpression('true');
    trim.mockRestore();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExpressionError);
      expect(result.error.cause).toBeInstanceOf(RangeError);
    }
  });

  it('拒绝空表达式、不支持的语法和非法 token', () => {
    for (const source of [
      '',
      '   ',
      '$deps.',
      '$deps.a.',
      '$deps.a + 1',
      '$deps.__proto__',
      '$deps.user.constructor',
      'unknown',
      '@',
    ]) {
      expect(compileExpression(source).ok).toBe(false);
    }
    expect(compileExpression('-').ok).toBe(false);
    expect(compileExpression('1.').ok).toBe(true);
    expect(compileExpression('1 === 1').ok).toBe(true);
    expect(compileExpression('true !== false').ok).toBe(true);
  });

  it('支持字符串转义并识别未闭合字面量', () => {
    const compiled = compileExpression("$deps.value === 'a\\n\\\"b'");
    expect(compiled.ok).toBe(true);
    expect(compileExpression("'unterminated").ok).toBe(false);
    expect(compileExpression("'trailing\\").ok).toBe(false);
  });

  it('计算嵌套字段和布尔运算', () => {
    const expression = compileExpression<boolean>(
      '(!$deps.user.locked && ($deps.count === 2 || $deps.mode !== null))',
    );
    expect(expression.ok).toBe(true);
    if (!expression.ok) return;
    expect(expression.value.evaluate({ user: { locked: false }, count: 2, mode: null })).toEqual({
      ok: true,
      value: true,
    });
    expect(expression.value.evaluate({ user: { locked: true }, count: 1, mode: null })).toEqual({
      ok: true,
      value: false,
    });
    expect(evaluateExpression('true || $deps.missing', {})).toEqual({ ok: true, value: true });
  });

  it('支持 Unicode 和带数字后缀的扁平字段名', () => {
    const compiled = compileExpression("{{$deps.手机号2 === 'ok' && $deps.field2 === true}}");
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.deps).toEqual(['手机号2', 'field2']);
      expect(compiled.value.evaluate({ 手机号2: 'ok', field2: true })).toEqual({
        ok: true,
        value: true,
      });
    }
  });

  it('保留普通字面量并拒绝非法动作模板', () => {
    expect(isExpressionTemplate('{{ $deps.value }}')).toBe(true);
    expect(isExpressionTemplate('{{')).toBe(false);
    expect(isExpressionTemplate(1)).toBe(false);
    expect(evaluateActionValue(42, {})).toEqual({ ok: true, value: 42 });
    expect(evaluateActionValue('{{$deps.value + 1}}', { value: 1 }).ok).toBe(false);
    expect(actionDependencies('not-an-expression')).toEqual([]);
    expect(actionDependencies('{{$deps.a}}')).toEqual(['a']);
  });
});

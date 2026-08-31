import { describe, expect, it } from 'vitest';
import {
  actionDependencies,
  compileExpression,
  evaluateActionValue,
  evaluateExpression,
  isExpressionTemplate,
} from './expression';

describe('safe dependency expression DSL', () => {
  it('compiles literals, paths and operators', () => {
    const compiled = compileExpression<boolean>("{{$deps.status === 'show' && !$deps.locked}}");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.deps).toEqual(['status', 'locked']);
    expect(compiled.value.evaluate({ status: 'show', locked: false })).toEqual({
      ok: true,
      value: true,
    });
    expect(compiled.value.evaluate({ status: 'hide', locked: false })).toEqual({
      ok: true,
      value: false,
    });
  });

  it('supports nested paths, parentheses, decimals and null', () => {
    const compiled = compileExpression('($deps.user.active === true) || ($deps.score === .5)');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.evaluate({ user: { active: false }, score: 0.5 })).toEqual({
      ok: true,
      value: true,
    });
    expect(compileExpression('$deps.value === null').ok).toBe(true);
  });

  it('rejects unsupported JavaScript and malformed syntax', () => {
    expect(compileExpression('   ').ok).toBe(false);
    expect(compileExpression('{{$deps.value + 1 === 2}}').ok).toBe(false);
    expect(compileExpression("{{$deps.value === 'x'}} trailing").ok).toBe(false);
    expect(compileExpression('{{$deps.value === (true}}').ok).toBe(false);
    expect(compileExpression('{{$deps.value; globalThis.alert(1)}}').ok).toBe(false);
    expect(compileExpression('{{$deps.}}').ok).toBe(false);
    expect(compileExpression('{{$deps.value.}}').ok).toBe(false);
    expect(compileExpression('{{$deps.1value}}').ok).toBe(false);
    expect(compileExpression("'unterminated").ok).toBe(false);
    expect(compileExpression("'escape\\").ok).toBe(false);
    expect(compileExpression('-').ok).toBe(false);
    expect(compileExpression('@').ok).toBe(false);
    expect(compileExpression(')').ok).toBe(false);
    expect(compileExpression('!').ok).toBe(false);
    expect(compileExpression('()').ok).toBe(false);
  });

  it('evaluates action templates and extracts dependencies', () => {
    expect(isExpressionTemplate('{{$deps.value}}')).toBe(true);
    expect(isExpressionTemplate('literal')).toBe(false);
    expect(evaluateActionValue('literal', {})).toEqual({ ok: true, value: 'literal' });
    expect(evaluateActionValue('{{$deps.value}}', { value: 42 })).toEqual({ ok: true, value: 42 });
    expect(actionDependencies('{{$deps.a === $deps.b}}')).toEqual(['a', 'b']);
    expect(actionDependencies('invalid')).toEqual([]);
    expect(actionDependencies('{{invalid}}')).toEqual([]);
    expect(isExpressionTemplate(42)).toBe(false);
    expect(evaluateExpression('{{$deps.a !== 0}}', { a: 1 })).toEqual({ ok: true, value: true });
    const throwingValues = new Proxy(
      {},
      {
        get: () => {
          throw new Error('read failed');
        },
      },
    );
    const evaluated = compileExpression('{{$deps.value}}');
    expect(evaluated.ok && evaluated.value.evaluate(throwingValues)).toMatchObject({ ok: false });
  });

  it('covers all operator and string literal branches', () => {
    const compiled = compileExpression("!false || (1 !== 2 && 'a\\n' === 'a\\n')");
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.value.evaluate({})).toEqual({ ok: true, value: true });
    const escaped = compileExpression("'a\\q' === 'a\\q'");
    expect(escaped.ok && escaped.value.evaluate({})).toEqual({ ok: true, value: true });
  });
});

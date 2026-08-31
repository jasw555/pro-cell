import { describe, expect, it, vi } from 'vitest';
import {
  DependencyCycleError,
  ReactionExecutionError,
  SchemaParseError,
} from '@jasw/pro-cell-shared';
import type { ReactionConfig, SchemaNode } from '@jasw/pro-cell-shared';
import { DependencyTracker } from './dependency-tracker';

const node = (name: string, reactions: readonly ReactionConfig[] = []): SchemaNode => ({
  $comp: 'Input',
  name,
  ...(reactions.length > 0 ? { reactions } : {}),
});

describe('DependencyTracker defensive and transaction paths', () => {
  it('非法配置和已销毁 tracker 返回领域错误', () => {
    const tracker = new DependencyTracker();
    expect(tracker.registerSchema({ $comp: '' } as unknown as SchemaNode).ok).toBe(false);
    expect(
      tracker.registerSchema({
        $comp: 'Input',
        reactions: [{ when: '{{$deps.a}}', then: {} }],
      } as SchemaNode).ok,
    ).toBe(false);
    expect(
      tracker.registerSchema({
        $comp: 'Input',
        name: '   ',
        reactions: [{ when: 'true', then: {} }],
      } as SchemaNode).ok,
    ).toBe(false);
    expect(tracker.registerReaction('a', { when: '{{', then: {} }).ok).toBe(false);
    tracker.dispose();
    expect(tracker.initialize().ok).toBe(false);
    const disposedNotify = tracker.notify('a', 1, 2);
    expect(disposedNotify.ok).toBe(false);
    if (!disposedNotify.ok) expect(disposedNotify.error).toBeInstanceOf(ReactionExecutionError);
    const disposedRegister = tracker.registerSchema(node('a'));
    expect(disposedRegister.ok).toBe(false);
    if (!disposedRegister.ok) expect(disposedRegister.error).toBeInstanceOf(SchemaParseError);
    expect(tracker.registerReaction('field', { when: 'true', then: {} }).ok).toBe(false);

    const active = new DependencyTracker();
    expect(active.registerReaction('', { when: 'true', then: {} }).ok).toBe(false);
    expect(
      active.registerReaction('field', {
        when: 'true',
        then: undefined,
      } as unknown as ReactionConfig).ok,
    ).toBe(false);
    const throwingConfig = new Proxy(
      { when: 'true', then: {} },
      {
        get(target, property, receiver) {
          if (property === 'then') throw new Error('read reaction');
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as ReactionConfig;
    expect(active.registerReaction('field', throwingConfig).ok).toBe(false);
    const throwingWhen = new Proxy(
      { when: 'true', then: {} },
      {
        get() {
          throw new Error('read when');
        },
      },
    ) as unknown as ReactionConfig;
    expect(active.registerReaction('field', throwingWhen).ok).toBe(false);
  });

  it('executes action expressions, else branches and tracks topological order', () => {
    const values: Record<string, unknown> = { source: false, flag: 'yes' };
    const updates: unknown[] = [];
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setVisible: (_path, value) => {
        updates.push(['visible', value]);
      },
      setDisabled: (_path, value) => {
        updates.push(['disabled', value]);
      },
      setValue: (path, value) => {
        values[path] = value;
        updates.push(['value', value]);
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Fragment',
        children: [
          node('target', [
            {
              when: '{{$deps.source === true}}',
              then: {
                setVisible: '{{$deps.source}}',
                setDisabled: false,
                setValue: '{{$deps.flag}}',
              },
              else: { setVisible: false, setDisabled: true },
            },
          ]),
        ],
      }).ok,
    ).toBe(true);
    expect(tracker.initialize(values).ok).toBe(true);
    expect(tracker.getVisible('target')).toBe(false);
    expect(tracker.getDisabled('target')).toBe(true);
    expect(tracker.getTopologicalOrder()).toEqual(expect.arrayContaining(['source', 'target']));
    values.source = true;
    expect(tracker.notify('source', false, true, 'test').ok).toBe(true);
    expect(updates).toContainEqual(['value', 'yes']);
    expect(tracker.getValue('flag')).toBe('yes');
  });

  it('在外部 getter 尚未同步时仍使用 notify 提供的 next 求值', () => {
    const values: Record<string, unknown> = { status: 'hide' };
    const visible = new Map<string, boolean>();
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setVisible: (path, value) => {
        visible.set(path, value);
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Fragment',
        children: [
          node('target', [
            {
              when: "{{$deps.status === 'show'}}",
              then: { setVisible: true },
              else: { setVisible: false },
            },
          ]),
        ],
      }).ok,
    ).toBe(true);

    expect(tracker.initialize({ status: 'hide' }).ok).toBe(true);
    // 这里不更新 `values`：同步事务内以 notify 收到的 next 值为准。
    expect(tracker.notify('status', 'hide', 'show').ok).toBe(true);
    expect(visible.get('target')).toBe(true);
  });

  it('在 setValue 适配器延迟同步 getter 时仍级联下游 reaction', () => {
    const values: Record<string, unknown> = { source: false, target: 0 };
    const updates: Array<[string, unknown]> = [];
    const visible: boolean[] = [];
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setValue: (path, value) => {
        updates.push([path, value]);
        // 保留旧的 values[target]，模拟下一轮事件才同步 getter 的适配器。
      },
      setVisible: (_path, value) => {
        visible.push(value);
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Fragment',
        children: [
          node('target', [{ when: '{{$deps.source === true}}', then: { setValue: 1 } }]),
          node('downstream', [{ when: '{{$deps.target === 1}}', then: { setVisible: true } }]),
        ],
      }).ok,
    ).toBe(true);
    expect(tracker.initialize(values).ok).toBe(true);
    expect(tracker.notify('source', false, true).ok).toBe(true);
    expect(updates).toContainEqual(['target', 1]);
    expect(visible).toContain(true);
  });

  it('外部 getter 读取失败会转换为 ReactionExecutionError', () => {
    const tracker = new DependencyTracker({
      getValue: (path) => {
        if (path === 'source') throw new Error('source read');
        return undefined;
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Input',
        name: 'target',
        reactions: [{ when: '{{$deps.source === true}}', then: { setVisible: true } }],
      }).ok,
    ).toBe(true);
    const result = tracker.notify('source', false, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ReactionExecutionError);
  });

  it('封装 setter/listener 异常并限制事务深度', () => {
    const invalidDepth = new DependencyTracker({ maxTransactionDepth: Number.NaN });
    expect(invalidDepth.notify('field', 0, 1).ok).toBe(true);

    const setterFailure = new DependencyTracker({
      setVisible: () => ({ ok: false, error: new Error('setter') }),
    });
    setterFailure.registerSchema({
      $comp: 'Fragment',
      children: [node('target', [{ when: '{{$deps.source}}', then: { setVisible: true } }])],
    });
    const setterResult = setterFailure.notify('source', false, true);
    expect(setterResult.ok).toBe(false);
    if (!setterResult.ok) expect(setterResult.error).toBeInstanceOf(ReactionExecutionError);

    const listenerFailure = new DependencyTracker();
    listenerFailure.subscribe('source', () => {
      throw new Error('listener');
    });
    const listenerResult = listenerFailure.notify('source', 0, 1);
    expect(listenerResult.ok).toBe(false);
    if (!listenerResult.ok) expect(listenerResult.error).toBeInstanceOf(ReactionExecutionError);

    const looping = new DependencyTracker({ maxTransactionDepth: 2, setValue: () => undefined });
    looping.registerSchema({
      $comp: 'Fragment',
      children: [
        node('target', [{ when: '{{$deps.source}}', then: { setValue: '{{$deps.source}}' } }]),
      ],
    });
    expect(looping.notify('source', false, true).ok).toBe(true);
    expect(looping.notify('target', 0, 1).ok).toBe(true);

    const thrownSetter = new DependencyTracker({
      setValue: () => {
        throw new Error('thrown');
      },
    });
    thrownSetter.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: 'true', then: { setValue: 1 } }],
    });
    const thrown = thrownSetter.initialize();
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.error.cause).toBeInstanceOf(Error);
  });

  it('限制因果链深度但不误伤宽扇出', () => {
    const values: Record<string, unknown> = { source: false };
    // createForm 默认使用 100 作为级联深度上限。101 个并列目标
    // 都只处于第二层，不应因队列项数量超过 100 而被拒绝。
    const targets = Array.from({ length: 101 }, (_, index) => `target${index}`);
    const tracker = new DependencyTracker({
      maxTransactionDepth: 100,
      getValue: (path) => values[path],
      setValue: (path, value) => {
        values[path] = value;
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Fragment',
        children: targets.map((target) =>
          node(target, [
            {
              when: '{{$deps.source === true}}',
              then: { setValue: true },
            },
          ]),
        ),
      }).ok,
    ).toBe(true);
    expect(tracker.initialize(values).ok).toBe(true);

    const result = tracker.notify('source', false, true);

    expect(result.ok).toBe(true);
    expect(targets.every((target) => values[target] === true)).toBe(true);
  });

  it('拒绝超过配置深度的真实级联链', () => {
    const values: Record<string, unknown> = { source: false };
    const tracker = new DependencyTracker({
      maxTransactionDepth: 2,
      getValue: (path) => values[path],
      setValue: (path, value) => {
        values[path] = value;
      },
    });
    expect(
      tracker.registerSchema({
        $comp: 'Fragment',
        children: [
          node('first', [{ when: '{{$deps.source === true}}', then: { setValue: true } }]),
          node('second', [{ when: '{{$deps.first === true}}', then: { setValue: true } }]),
        ],
      }).ok,
    ).toBe(true);
    expect(tracker.initialize(values).ok).toBe(true);

    const result = tracker.notify('source', false, true);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ReactionExecutionError);
      expect(result.error.field).toBe('second');
    }
  });

  it('still bounds a runtime loop created by a re-entrant listener', () => {
    const tracker = new DependencyTracker({ maxTransactionDepth: 3 });
    tracker.subscribe('counter', (event) => {
      const previous = typeof event.next === 'number' ? event.next : 0;
      tracker.notify('counter', previous, previous + 1, 'listener');
    });

    const result = tracker.notify('counter', -1, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ReactionExecutionError);
      expect(result.error.field).toBe('counter');
    }
  });

  it('封装依赖读取异常并处理重入通知', () => {
    const getterFailure = new DependencyTracker({
      getValue: () => {
        throw new Error('read');
      },
    });
    getterFailure.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: '{{$deps.source}}', then: { setVisible: true } }],
    });
    const failed = getterFailure.notify('source', false, true);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBeInstanceOf(ReactionExecutionError);

    const reentrant = new DependencyTracker();
    let nested: ReturnType<DependencyTracker['notify']> | undefined;
    reentrant.subscribe('source', () => {
      nested = reentrant.notify('nested', 0, 1);
    });
    expect(reentrant.notify('source', 0, 1).ok).toBe(true);
    expect(nested?.ok).toBe(true);
  });

  it('keeps re-entrant notifications out of the current reaction snapshot', () => {
    const visible: boolean[] = [];
    const tracker = new DependencyTracker({
      setVisible: (_field, value) => {
        visible.push(value);
      },
    });
    tracker.registerSchema({
      $comp: 'Fragment',
      children: [
        node('target', [
          {
            when: '{{$deps.source === true && $deps.nested === true}}',
            then: { setVisible: true },
          },
        ]),
      ],
    });
    expect(tracker.initialize({ source: false, nested: false }).ok).toBe(true);
    visible.length = 0;
    tracker.subscribe('source', () => {
      tracker.notify('nested', false, true);
    });

    expect(tracker.notify('source', false, true).ok).toBe(true);
    // source 事件先读到 nested=false；只有随后排队的 nested 事件会满足条件。
    expect(visible).toEqual([true]);
  });

  it('没有 else 时保持现状，并限制重入事务深度', () => {
    const noAction = new DependencyTracker();
    noAction.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: 'false', then: { setVisible: true } }],
    });
    expect(noAction.initialize().ok).toBe(true);
    expect(noAction.getVisible('target')).toBe(true);

    const trackerRef: { current: DependencyTracker | undefined } = { current: undefined };
    const tracker = new DependencyTracker({
      maxTransactionDepth: 1,
      setValue: (path, value) => {
        trackerRef.current?.notify(path, value, `${String(value)}:nested`);
      },
    });
    trackerRef.current = tracker;
    tracker.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: '{{$deps.source}}', then: { setValue: '{{$deps.source}}' } }],
    });
    const result = tracker.notify('source', false, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ReactionExecutionError);
  });

  it('supports listener ordering, unsubscribe and direct registration cycle rollback', () => {
    const tracker = new DependencyTracker();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = tracker.subscribe('field', first);
    tracker.subscribe('field', second);
    tracker.notify('field', 1, 2, 'source');
    expect(first).toHaveBeenCalledBefore(second);
    stopFirst();
    tracker.notify('field', 2, 3);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);

    const cycle = new DependencyTracker();
    expect(cycle.registerReaction('a', { when: '{{$deps.b}}', then: {} }).ok).toBe(true);
    expect(() => cycle.registerReaction('b', { when: '{{$deps.a}}', then: {} })).toThrow(
      DependencyCycleError,
    );
    expect(cycle.getTopologicalOrder()).toEqual(['b', 'a']);
  });

  it('does not confuse a user setValue object with internal expression metadata', () => {
    const literal = {
      __proCellExpression: true,
      compiled: { deps: ['not-an-expression'], evaluate: 'literal' },
    };
    const tracker = new DependencyTracker();
    expect(
      tracker.registerSchema({
        $comp: 'Input',
        name: 'target',
        reactions: [{ when: 'true', then: { setValue: literal } }],
      }).ok,
    ).toBe(true);
    expect(tracker.initialize().ok).toBe(true);
    expect(tracker.getValue('target')).toBe(literal);
  });
});

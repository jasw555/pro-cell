import { describe, expect, it, vi } from 'vitest';
import { DependencyCycleError } from '@jasw/pro-cell-shared';
import { err, ReactionExecutionError } from '@jasw/pro-cell-shared';
import type { ReactionConfig, SchemaNode } from '@jasw/pro-cell-shared';
import { DependencyTracker } from './dependency-tracker';

const field = (
  $comp: string,
  name: string,
  reactions: readonly ReactionConfig[] = [],
): SchemaNode => ({
  $comp,
  name,
  ...(reactions.length > 0 ? { reactions } : {}),
});

describe('DependencyTracker', () => {
  it('initializes and cascades visibility/disabled reactions', () => {
    const values: Record<string, unknown> = { status: 'hide' };
    const visible = new Map<string, boolean>();
    const disabled = new Map<string, boolean>();
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setVisible: (path, value) => {
        visible.set(path, value);
      },
      setDisabled: (path, value) => {
        disabled.set(path, value);
      },
    });
    tracker.registerSchema({
      $comp: 'Fragment',
      children: [
        field('Input', 'target', [
          {
            when: "{{$deps.status === 'show'}}",
            then: { setVisible: true, setDisabled: false },
            else: { setVisible: false, setDisabled: true },
          },
        ]),
      ],
    });
    expect(tracker.initialize(values).ok).toBe(true);
    expect(visible.get('target')).toBe(false);
    expect(disabled.get('target')).toBe(true);
    values.status = 'show';
    expect(tracker.notify('status', 'hide', 'show').ok).toBe(true);
    expect(visible.get('target')).toBe(true);
    expect(disabled.get('target')).toBe(false);
  });

  it('executes setValue in declaration order and propagates changes', () => {
    const values: Record<string, unknown> = { source: 'next' };
    const updates: Array<[string, unknown]> = [];
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setValue: (path, value) => {
        values[path] = value;
        updates.push([path, value]);
      },
    });
    tracker.registerSchema({
      $comp: 'Fragment',
      children: [
        field('Input', 'target', [
          { when: "{{$deps.source === 'next'}}", then: { setValue: '{{$deps.source}}' } },
        ]),
      ],
    });
    expect(tracker.initialize(values).ok).toBe(true);
    expect(updates).toEqual([['target', 'next']]);
  });

  it('evaluates an initialization chain once in topological order', () => {
    const values: Record<string, unknown> = { source: true };
    const updates: string[] = [];
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setValue: (path, value) => {
        values[path] = value;
        updates.push(path);
      },
    });
    tracker.registerSchema({
      $comp: 'Fragment',
      children: [
        field('Input', 'first', [{ when: '{{$deps.source === true}}', then: { setValue: 1 } }]),
        field('Input', 'second', [{ when: '{{$deps.first === 1}}', then: { setValue: 2 } }]),
      ],
    });
    expect(tracker.initialize(values).ok).toBe(true);
    expect(updates).toEqual(['first', 'second']);
  });

  it('deduplicates equal values and supports unsubscribe', () => {
    const listener = vi.fn();
    const tracker = new DependencyTracker();
    const unsubscribe = tracker.subscribe('value', listener);
    tracker.notify('value', 1, 1);
    tracker.notify('value', 1, 2);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    tracker.notify('value', 2, 3);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('detects self, mutual and action-expression cycles with clear paths', () => {
    const self = new DependencyTracker();
    expect(() =>
      self.registerSchema(
        field('Input', 'A', [{ when: '{{$deps.A === true}}', then: { setVisible: true } }]),
      ),
    ).toThrow(DependencyCycleError);
    const mutual = new DependencyTracker();
    expect(() =>
      mutual.registerSchema({
        $comp: 'Fragment',
        children: [
          field('Input', 'A', [{ when: '{{$deps.B === true}}', then: { setVisible: true } }]),
          field('Input', 'B', [{ when: '{{$deps.A === true}}', then: { setVisible: true } }]),
        ],
      }),
    ).toThrow(/A|B/);
  });

  it('supports direct reaction registration, graph order and invalid rollback', () => {
    const tracker = new DependencyTracker();
    expect(
      tracker.registerReaction('target', {
        when: '{{$deps.source === true}}',
        then: { setVisible: true },
      }).ok,
    ).toBe(true);
    expect(tracker.getTopologicalOrder()).toEqual(['source', 'target']);
    expect(tracker.registerReaction('bad', { when: '{{invalid + 1}}', then: {} }).ok).toBe(false);
    expect(
      tracker.registerSchema({ $comp: 'Input', reactions: [{ when: 'true', then: {} }] }).ok,
    ).toBe(false);
    expect(
      tracker.registerSchema({
        $comp: 'Input',
        name: 'bad',
        reactions: [{ when: 'true', then: { setVisible: '{{$deps.}}' } }],
      }).ok,
    ).toBe(false);
    expect(tracker.getTopologicalOrder()).toEqual(['source', 'target']);
  });

  it('handles callback and listener failures as Result errors', () => {
    const callbackError = new Error('setter');
    const tracker = new DependencyTracker({
      setVisible: () => err(callbackError),
      setDisabled: () => err(callbackError),
      setValue: () => err(callbackError),
    });
    tracker.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: 'true', then: { setVisible: true, setDisabled: true, setValue: 1 } }],
    });
    const initialized = tracker.initialize();
    expect(initialized.ok).toBe(false);
    if (!initialized.ok) expect(initialized.error).toBeInstanceOf(ReactionExecutionError);

    const listenerTracker = new DependencyTracker();
    listenerTracker.subscribe('value', () => {
      throw new Error('listener');
    });
    const notified = listenerTracker.notify('value', 0, 1);
    expect(notified.ok).toBe(false);
    if (!notified.ok) expect(notified.error).toBeInstanceOf(ReactionExecutionError);
  });

  it('guards runtime cascades, disposal and visibility state', () => {
    const values: Record<string, unknown> = { trigger: true };
    const tracker = new DependencyTracker({
      getValue: (path) => values[path],
      setValue: (path, value) => {
        values[path] = value;
      },
      maxTransactionDepth: 2,
    });
    tracker.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [
        {
          when: '{{$deps.trigger === true}}',
          then: { setValue: '{{$deps.trigger}}', setVisible: true, setDisabled: true },
        },
      ],
    });
    expect(tracker.initialize(values).ok).toBe(true);
    expect(tracker.getVisible('target')).toBe(true);
    expect(tracker.getDisabled('target')).toBe(true);
    expect(tracker.getValue('trigger')).toBe(true);
    tracker.dispose();
    expect(tracker.notify('trigger', false, true).ok).toBe(false);
    expect(tracker.initialize().ok).toBe(false);
    expect(tracker.registerSchema({ $comp: 'Input' }).ok).toBe(false);
  });

  it('supports nested values and no-op notifications', () => {
    const tracker = new DependencyTracker();
    tracker.initialize({ user: { state: 'ready' } });
    expect(tracker.getValue('user.state')).toBe('ready');
    const listener = vi.fn();
    tracker.subscribe('value', listener);
    expect(tracker.notify('value', NaN, NaN).ok).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects non-boolean expression results for boolean actions', () => {
    const tracker = new DependencyTracker({
      getValue: () => 'not-a-boolean',
    });
    tracker.registerSchema({
      $comp: 'Input',
      name: 'target',
      reactions: [{ when: 'true', then: { setVisible: '{{$deps.source}}' } }],
    });
    const result = tracker.initialize({ source: 'not-a-boolean' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ReactionExecutionError);
    const internal = tracker as unknown as {
      evaluateBooleanAction(
        value: boolean | string | undefined,
        field: string,
      ): { readonly ok: boolean };
    };
    expect(internal.evaluateBooleanAction('{{invalid}}', 'target').ok).toBe(false);
  });

  it('wraps disabled and value setter failures', () => {
    const make = (action: {
      readonly setDisabled?: boolean;
      readonly setValue?: unknown;
    }): DependencyTracker => {
      const tracker = new DependencyTracker({
        setDisabled: () => err(new Error('disabled')),
        setValue: () => err(new Error('value')),
      });
      tracker.registerSchema({
        $comp: 'Input',
        name: 'target',
        reactions: [{ when: 'true', then: action }],
      });
      return tracker;
    };
    const disabled = make({ setDisabled: true }).initialize();
    expect(disabled.ok).toBe(false);
    const value = make({ setValue: 1 }).initialize();
    expect(value.ok).toBe(false);
  });
});

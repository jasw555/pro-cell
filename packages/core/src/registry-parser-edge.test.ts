import { createElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ComponentRegistry,
  createComponentRegistry,
  defaultRegistry,
  getRegisteredComponent,
  registerComponent,
} from './registry';
import { SchemaParser } from './schema-parser';
import { ComponentNotFoundError, SchemaParseError, ok } from '@jasw/pro-cell-shared';

function View(props: Record<string, unknown>): ReactElement {
  return createElement('div', props);
}

describe('registry and parser defensive paths', () => {
  it('validates registration options and exposes registry helpers', () => {
    const registry = createComponentRegistry();
    expect(registry.register('  ', View).ok).toBe(false);
    expect(registry.register('bad', 1 as unknown as typeof View).ok).toBe(false);
    expect(
      registry.register('bad-value-prop', View, {
        valueProp: 1 as unknown as string,
      }).ok,
    ).toBe(false);
    expect(
      registry.register('bad-change-prop', View, {
        changeProp: 1 as unknown as string,
      }).ok,
    ).toBe(false);
    expect(
      registry.register('bad-event-adapter', View, {
        eventToValue: 1 as unknown as (event: unknown) => unknown,
      }).ok,
    ).toBe(false);
    const hostileOptions = new Proxy(
      {},
      {
        get() {
          throw new Error('options getter');
        },
      },
    ) as unknown as Parameters<typeof registry.register>[2];
    expect(registry.register('hostile-options', View, hostileOptions).ok).toBe(false);
    expect(registry.register('View', View, { valueProp: ' ', changeProp: ' ' }).ok).toBe(true);
    const entry = registry.get('View');
    expect(entry?.valueProp).toBe('value');
    expect(entry?.changeProp).toBe('onChange');
    expect(entry?.eventToValue({ target: { checked: true } })).toBe(true);
    expect(entry?.eventToValue({ target: { value: 'x' } })).toBe('x');
    expect(entry?.eventToValue('plain')).toBe('plain');
    expect(registry.entries()).toHaveLength(1);
    expect(registry.getVersion()).toBe(1);
    expect(registry.has('View')).toBe(true);
    expect(registry.unregister('missing')).toBe(false);
    expect(registry.unregister('View')).toBe(true);
    expect(registry.getVersion()).toBe(2);
  });

  it('supports global registration aliases and missing component errors', () => {
    const name = `EdgeView_${Date.now()}`;
    expect(registerComponent(name, View).ok).toBe(true);
    expect(getRegisteredComponent(undefined, name)?.name).toBe(name);
    const missing = defaultRegistry.resolve('__missing_edge_component__', 'root');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBeInstanceOf(ComponentNotFoundError);
    defaultRegistry.unregister(name);
  });

  it('renders fragments, children, resolved props and parsed ASTs', () => {
    const registry = new ComponentRegistry();
    registry.register('View', View);
    const parser = new SchemaParser(registry);
    const schema = {
      $comp: 'Fragment',
      children: [
        { $comp: 'View', name: 'one', props: { id: 'one' } },
        { $comp: 'View', name: 'two', children: [{ $comp: 'View', name: 'nested' }] },
      ],
    } as const;
    const rendered = parser.parse(schema, {
      resolveProps: (node, path) => ({ 'data-path': `${path}:${node.$comp}` }),
    });
    expect(rendered.ok).toBe(true);
    expect(parser.parseWithAst(schema).ok).toBe(true);
    expect(parser.normalize(schema).ok).toBe(true);
    expect(parser.parse('{"$comp":"Fragment","children":[]}').ok).toBe(true);
    expect(parser.parseOrThrow(schema)).toBeTruthy();
  });

  it('将非法 JSON、Schema 和未知组件转换为领域错误', () => {
    const parser = new SchemaParser(new ComponentRegistry());
    for (const value of [
      '{',
      'null',
      '{}',
      '{"$comp":1}',
      { $comp: '' },
      { $comp: 'View', children: [null] },
    ]) {
      const result = parser.parse(value as unknown as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(SchemaParseError);
    }
    const unknown = parser.parse({ $comp: 'Unknown' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBeInstanceOf(ComponentNotFoundError);

    const cyclic = { $comp: 'Fragment' } as { $comp: string; children?: unknown[] };
    cyclic.children = [cyclic];
    const cycleResult = parser.parse(cyclic as never);
    expect(cycleResult.ok).toBe(false);
    if (!cycleResult.ok) expect(cycleResult.error).toBeInstanceOf(SchemaParseError);

    const unnamedRules = parser.parse({
      $comp: 'View',
      rules: [{ type: 'required' }],
    });
    expect(unnamedRules.ok).toBe(false);
    if (!unnamedRules.ok) expect(unnamedRules.error).toBeInstanceOf(SchemaParseError);

    const emptyNameReaction = parser.parse({
      $comp: 'View',
      name: '   ',
      reactions: [{ when: 'true', then: {} }],
    });
    expect(emptyNameReaction.ok).toBe(false);
    if (!emptyNameReaction.ok) expect(emptyNameReaction.error).toBeInstanceOf(SchemaParseError);

    const hostile = new Proxy(
      { $comp: 'View' },
      {
        get: () => {
          throw new Error('getter');
        },
      },
    );
    const hostileResult = parser.parse(hostile as never);
    expect(hostileResult.ok).toBe(false);
    if (!hostileResult.ok) expect(hostileResult.error).toBeInstanceOf(SchemaParseError);
  });

  it('covers parser result branches, fallback paths, and hostile registries', () => {
    const registry = new ComponentRegistry();
    registry.register('View', View);
    const parser = new SchemaParser(new ComponentRegistry());

    // parseWithAst returns the normalization error branch before rendering.
    expect(parser.parseWithAst('{').ok).toBe(false);
    // A normalized node can still fail during component resolution.
    expect(parser.parseWithAst({ $comp: 'Missing' }).ok).toBe(false);

    // 同时覆盖 reactions 的 name 约束和独立注册表覆盖。
    expect(
      parser.normalize({
        $comp: 'View',
        name: 'reactive',
        reactions: [{ when: 'true', then: {} }],
      }).ok,
    ).toBe(true);
    expect(parser.parse({ $comp: 'View' }, { registry }).ok).toBe(true);

    // Unnamed children use their deterministic index path; failed descendants
    // are returned rather than escaping as exceptions.
    expect(
      parser.parse({ $comp: 'Fragment', children: [{ $comp: 'View' }] }, { registry }).ok,
    ).toBe(true);
    expect(
      parser.parse({ $comp: 'Fragment', children: [{ $comp: 'Missing' }] }, { registry }).ok,
    ).toBe(false);
    expect(parser.parse({ $comp: 'View', children: [{ $comp: 'Missing' }] }, { registry }).ok).toBe(
      false,
    );

    // 自定义注册表返回非法组件或抛错时，解析器统一返回 SchemaParseError。
    const invalidComponentRegistry = {
      resolve: () =>
        ok({
          name: 'Broken',
          get component(): never {
            throw new Error('invalid component');
          },
          valueProp: 'value',
          changeProp: 'onChange',
          eventToValue: (event: unknown): unknown => event,
        }),
    } as unknown as ComponentRegistry;
    const invalidResult = new SchemaParser(invalidComponentRegistry).parse({ $comp: 'Broken' });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.error).toBeInstanceOf(SchemaParseError);

    const throwingRegistry = {
      resolve: () => {
        throw new Error('registry failed');
      },
    } as unknown as ComponentRegistry;
    const throwingResult = new SchemaParser(throwingRegistry).parse({ $comp: 'View' });
    expect(throwingResult.ok).toBe(false);
    if (!throwingResult.ok) expect(throwingResult.error).toBeInstanceOf(SchemaParseError);
  });

  it('wraps property resolver failures as schema errors', () => {
    const registry = new ComponentRegistry();
    registry.register('View', View);
    const parser = new SchemaParser(registry);
    const result = parser.parse(
      { $comp: 'View', name: 'field' },
      {
        resolveProps: () => {
          throw new Error('props failed');
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(SchemaParseError);
  });
});

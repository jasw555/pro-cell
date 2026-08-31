import { describe, expect, it } from 'vitest';
import { createElement, forwardRef, type ReactElement } from 'react';
import { ComponentNotFoundError } from '@jasw/pro-cell-shared';
import {
  ComponentRegistry,
  createComponentRegistry,
  defaultRegistry,
  getRegisteredComponent,
  registerComponent,
} from './registry';
import { SchemaParser } from './schema-parser';
import * as core from './index';

function Input(props: Record<string, unknown>): ReactElement {
  return createElement('input', props);
}

describe('component registry and SchemaParser', () => {
  it('registers, resolves, rejects duplicates and supports overrides', () => {
    const registry = new ComponentRegistry();
    expect(registry.registerComponent('Input', Input)).toMatchObject({ ok: true });
    expect(registry.registerComponent('Input', Input).ok).toBe(false);
    expect(registry.registerComponent('Input', Input, { override: true }).ok).toBe(true);
    expect(registry.resolve('Input').ok).toBe(true);
    const missing = registry.resolve('Missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBeInstanceOf(ComponentNotFoundError);
    expect(registry.has('Input')).toBe(true);
    expect(registry.getVersion()).toBe(2);
    expect(registry.entries()).toHaveLength(1);
    expect(registry.unregister('Missing')).toBe(false);
    expect(registry.unregister('Input')).toBe(true);
    expect(registry.has('Input')).toBe(false);
    expect(registry.getVersion()).toBe(3);
  });

  it('validates registration options and adapts event values', () => {
    const registry = createComponentRegistry();
    expect(registry.register('  ', Input).ok).toBe(false);
    expect(registry.register('Bad', null as unknown as typeof Input).ok).toBe(false);
    expect(registry.register('Object', {} as unknown as typeof Input).ok).toBe(false);
    expect(registry.register('Input', Input, { valueProp: ' ', changeProp: ' ' }).ok).toBe(true);
    const entry = registry.get('Input');
    expect(entry?.valueProp).toBe('value');
    expect(entry?.changeProp).toBe('onChange');
    expect(entry?.eventToValue({ target: { checked: true } })).toBe(true);
    expect(entry?.eventToValue({ target: { value: 'x' } })).toBe('x');
    expect(entry?.eventToValue('raw')).toBe('raw');
    const custom = (event: unknown): unknown => ({ event });
    expect(
      registry.register('Custom', Input, {
        eventToValue: custom,
        valueProp: 'checked',
        changeProp: 'onToggle',
      }).ok,
    ).toBe(true);
    expect(registry.get('Custom')?.eventToValue('x')).toEqual({ event: 'x' });
    const objectComponent = forwardRef<HTMLInputElement, Record<string, unknown>>(() =>
      createElement('input'),
    );
    expect(registry.register('ForwardRef', objectComponent).ok).toBe(true);
    expect(registerComponent('CoreTestInput', Input).ok).toBe(true);
    expect(getRegisteredComponent(undefined, 'CoreTestInput')).toBeDefined();
    defaultRegistry.unregister('CoreTestInput');
  });

  it('recursively renders children and memoizes normalized nodes in WeakMap', () => {
    const registry = new ComponentRegistry();
    registry.register('Input', Input);
    const parser = new SchemaParser(registry);
    const schema = {
      $comp: 'Fragment',
      children: [
        {
          $comp: 'Input',
          name: 'first',
          props: { 'data-id': 'first' },
          children: [{ $comp: 'Input', name: 'second' }],
        },
      ],
    } as const;
    const first = parser.normalize(schema);
    const second = parser.normalize(schema);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value).toBe(second.value);
    const rendered = parser.parse(schema);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.value).toBeTruthy();
    }
    const withProps = parser.parseWithAst(schema, {
      resolveProps: (_node, path) => ({ 'data-path': path }),
    });
    expect(withProps.ok).toBe(true);
  });

  it('parses JSON strings and reports malformed/unknown schemas', () => {
    const parser = new SchemaParser(new ComponentRegistry());
    expect(parser.parse('{"$comp":"Fragment","children":[]}').ok).toBe(true);
    expect(parser.parse('{not-json').ok).toBe(false);
    const unknown = parser.parse({ $comp: 'NoSuchComponent' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBeInstanceOf(ComponentNotFoundError);
    expect(() => parser.parseOrThrow({ $comp: 'NoSuchComponent' })).toThrow(ComponentNotFoundError);
    const customRegistry = new ComponentRegistry();
    customRegistry.register('Input', Input);
    const customParser = new SchemaParser(new ComponentRegistry());
    const customContext = customParser.parse(
      { $comp: 'Input' },
      { registry: customRegistry, path: 'custom' },
    );
    expect(customContext.ok).toBe(true);
    const childError = customParser.parse(
      { $comp: 'Input', children: [{ $comp: 'MissingChild' }] },
      { registry: customRegistry },
    );
    expect(childError.ok).toBe(false);
    expect(core.SchemaParser).toBe(SchemaParser);
  });
});

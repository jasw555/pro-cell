import { createElement, forwardRef, lazy, memo, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ReactComponentRegistry,
  createComponentRegistry,
  defaultRegistry,
  getRegisteredComponent,
  registerComponent,
} from './registry';
import type { ComponentAdapterOptions, RegisteredComponent } from './types';

function Input(props: Record<string, unknown>): ReactElement {
  return createElement('input', props);
}

describe('ReactComponentRegistry', () => {
  it('拒绝无效组件并接受 React 包装组件', () => {
    const registry = new ReactComponentRegistry();

    expect(registry.registerComponent('Null', null as unknown as typeof Input).ok).toBe(false);
    expect(registry.registerComponent('Invalid', {} as unknown as typeof Input).ok).toBe(false);
    const throwingMarker = Object.defineProperty({}, '$$typeof', {
      get: () => {
        throw new Error('marker failure');
      },
    });
    expect(
      registry.registerComponent('Throwing', throwingMarker as unknown as typeof Input).ok,
    ).toBe(false);
    expect(
      registry.registerComponent(
        'ForwardRef',
        forwardRef(() => createElement('input')),
      ).ok,
    ).toBe(true);
    expect(registry.registerComponent('Memo', memo(Input)).ok).toBe(true);
    expect(
      registry.registerComponent(
        'Lazy',
        lazy(() => Promise.resolve({ default: Input })),
      ).ok,
    ).toBe(true);
  });

  it('校验名称、配置形状和重复名称', () => {
    const registry = new ReactComponentRegistry();

    expect(registry.registerComponent(1 as unknown as string, Input).ok).toBe(false);
    expect(registry.registerComponent('   ', Input).ok).toBe(false);
    expect(registry.registerComponent('Input', Input).ok).toBe(true);
    expect(registry.registerComponent('Input', Input).ok).toBe(false);
    expect(registry.registerComponent('Input', Input, { override: true }).ok).toBe(true);
    expect(
      registry.registerComponent('BadValueProp', Input, {
        valueProp: 1,
      } as unknown as ComponentAdapterOptions).ok,
    ).toBe(false);
    expect(
      registry.registerComponent('BadChangeProp', Input, {
        changeProp: false,
      } as unknown as ComponentAdapterOptions).ok,
    ).toBe(false);
    expect(
      registry.registerComponent('BadEventAdapter', Input, {
        eventToValue: 'invalid',
      } as unknown as ComponentAdapterOptions).ok,
    ).toBe(false);

    const throwingOptions = Object.defineProperty({}, 'override', {
      get: () => {
        throw new Error('options failure');
      },
    }) as ComponentAdapterOptions;
    const result = registry.registerComponent('ThrowingOptions', Input, throwingOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toBeInstanceOf(Error);
  });

  it('应用默认、checked 和自定义事件适配规则', () => {
    const registry = new ReactComponentRegistry();
    expect(registry.registerComponent('Default', Input).ok).toBe(true);
    expect(
      registry.registerComponent('Checked', Input, {
        valueProp: ' checked ',
        changeProp: ' onChecked ',
      }).ok,
    ).toBe(true);
    const customAdapter = (event: unknown): unknown => ({ wrapped: event });
    expect(
      registry.register('Custom', Input, {
        valueProp: ' modelValue ',
        changeProp: ' update ',
        eventToValue: customAdapter,
      }).ok,
    ).toBe(true);

    const defaultEntry = registry.get('Default');
    const checkedEntry = registry.get('Checked');
    const customEntry = registry.get('Custom');
    if (defaultEntry === undefined || checkedEntry === undefined || customEntry === undefined) {
      throw new Error('注册表条目缺失');
    }
    expect(defaultEntry.eventToValue({ target: { value: 'text', checked: false } })).toBe('text');
    expect(defaultEntry.eventToValue({ target: { checked: true } })).toBe(true);
    expect(defaultEntry.eventToValue({ target: null })).toEqual({ target: null });
    expect(defaultEntry.eventToValue('direct')).toBe('direct');
    expect(checkedEntry.valueProp).toBe('checked');
    expect(checkedEntry.changeProp).toBe('onChecked');
    expect(checkedEntry.eventToValue({ target: { checked: false } })).toBe(false);
    expect(checkedEntry.eventToValue({ target: {} })).toEqual({ target: {} });
    expect(customEntry.valueProp).toBe('modelValue');
    expect(customEntry.changeProp).toBe('update');
    expect(customEntry.eventToValue('value')).toEqual({ wrapped: 'value' });
  });

  it('维护版本、解析结果、删除语义和条目快照', () => {
    const registry = createComponentRegistry();
    expect(registry.getVersion()).toBe(0);
    expect(registry.has('Input')).toBe(false);
    expect(registry.resolve('Input', 'root.input').ok).toBe(false);

    expect(registry.register(' Input ', Input).ok).toBe(true);
    expect(registry.getVersion()).toBe(1);
    expect(registry.has('Input')).toBe(true);
    const resolved = registry.resolve('Input');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.component).toBe(Input);

    const snapshot = registry.entries();
    (snapshot as RegisteredComponent[]).length = 0;
    expect(registry.entries()).toHaveLength(1);
    expect(registry.unregister('Missing')).toBe(false);
    expect(registry.getVersion()).toBe(1);
    expect(registry.unregister('Input')).toBe(true);
    expect(registry.getVersion()).toBe(2);
    expect(registry.get('Input')).toBeUndefined();
  });

  it('支持默认注册表便捷函数和显式注册表查询', () => {
    expect(registerComponent('RegistryGlobalProbe', Input, { override: true }).ok).toBe(true);
    expect(getRegisteredComponent(undefined, 'RegistryGlobalProbe')).toBe(
      defaultRegistry.get('RegistryGlobalProbe'),
    );

    const isolated = createComponentRegistry();
    expect(isolated.registerComponent('Isolated', Input).ok).toBe(true);
    expect(getRegisteredComponent(isolated, 'Isolated')).toBe(isolated.get('Isolated'));
    expect(getRegisteredComponent(isolated, 'RegistryGlobalProbe')).toBeUndefined();
  });
});

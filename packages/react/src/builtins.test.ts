import {
  Fragment,
  createElement,
  isValidElement,
  type ComponentType,
  type ReactElement,
} from 'react';
import {
  Input as AntInput,
  Select as AntSelect,
  Switch as AntSwitch,
  Table as AntTable,
} from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  FragmentComponent,
  InputComponent,
  SelectComponent,
  SwitchComponent,
  TableComponent,
  builtins,
  getBuiltinComponent,
  registerBuiltinComponents,
} from './builtins';
import { ReactComponentRegistry } from './registry';
import type { ComponentAdapterOptions, RegisteredComponent } from './types';

function expectElement(node: unknown): ReactElement<Record<string, unknown>> {
  if (!isValidElement<Record<string, unknown>>(node)) {
    throw new Error('期望得到 ReactElement');
  }
  return node;
}

function ProbeComponent(): ReactElement {
  return createElement('span');
}

describe('内置组件适配器', () => {
  it('创建 antd 元素并过滤显式 children 属性', () => {
    const cases = [
      [InputComponent, AntInput],
      [SelectComponent, AntSelect],
      [SwitchComponent, AntSwitch],
      [TableComponent, AntTable],
    ] as const;

    for (const [adapter, expectedType] of cases) {
      const element = expectElement(adapter({ id: 'field', children: 'ignored' }));
      expect(element.type).toBe(expectedType);
      expect(element.props.id).toBe('field');
      expect(element.props.children).toBeUndefined();
    }

    const fragment = expectElement(FragmentComponent({ children: ['first', 'second'] }));
    expect(fragment.type).toBe(Fragment);
    expect(fragment.props.children).toEqual(['first', 'second']);
  });

  it('按 Input、Select、Switch 的事件语义提取值', () => {
    const definitions = new Map(builtins.map((definition) => [definition.name, definition]));
    const input = definitions.get('Input');
    const select = definitions.get('Select');
    const switchDefinition = definitions.get('Switch');
    const table = definitions.get('Table');
    const fragment = definitions.get('Fragment');
    if (
      input === undefined ||
      select === undefined ||
      switchDefinition === undefined ||
      table === undefined ||
      fragment === undefined
    ) {
      throw new Error('内置组件定义不完整');
    }

    expect(input.options.eventToValue?.({ target: { value: 'next' } })).toBe('next');
    expect(input.options.eventToValue?.({ target: null })).toEqual({ target: null });
    expect(input.options.eventToValue?.('direct')).toBe('direct');
    expect(select.options.eventToValue?.('selected')).toBe('selected');
    expect(switchDefinition.options.eventToValue?.(true)).toBe(true);
    expect(switchDefinition.options.eventToValue?.({ target: { checked: false } })).toBe(false);
    expect(switchDefinition.options.eventToValue?.({ target: {} })).toEqual({ target: {} });
    expect(table.options.eventToValue?.(['row'])).toEqual(['row']);
    expect(fragment.options.eventToValue?.('value')).toBe('value');
  });

  it('提供冻结的只读索引，并对未知名称返回 undefined', () => {
    const input = getBuiltinComponent('Input');
    expect(input).toBeDefined();
    expect(Object.isFrozen(input)).toBe(true);
    expect(input?.valueProp).toBe('value');
    expect(input?.changeProp).toBe('onChange');
    expect(getBuiltinComponent('Missing')).toBeUndefined();
  });
});

describe('registerBuiltinComponents', () => {
  it('向 ReactComponentRegistry 幂等注册，且不覆盖用户的同名组件', () => {
    const registry = new ReactComponentRegistry();
    expect(registry.registerComponent('Input', ProbeComponent).ok).toBe(true);
    const customInput = registry.get('Input');

    registerBuiltinComponents(registry);
    const versionAfterFirstRegistration = registry.getVersion();

    expect(registry.entries()).toHaveLength(5);
    expect(registry.get('Input')).toBe(customInput);
    expect(registry.get('Switch')?.valueProp).toBe('checked');
    registerBuiltinComponents(registry);
    expect(registry.getVersion()).toBe(versionAfterFirstRegistration);
  });

  it('兼容只有 get/registerComponent 的最小自定义注册表', () => {
    const entries = new Map<string, RegisteredComponent>();
    entries.set('Input', {
      name: 'Input',
      component: ProbeComponent,
      valueProp: 'value',
      changeProp: 'onChange',
      eventToValue: (event: unknown) => event,
    });
    const registerComponent = vi.fn(
      (
        name: string,
        component: ComponentType<Record<string, unknown>>,
        options: ComponentAdapterOptions = {},
      ): void => {
        entries.set(name, {
          name,
          component,
          valueProp: options.valueProp ?? 'value',
          changeProp: options.changeProp ?? 'onChange',
          eventToValue: options.eventToValue ?? ((event: unknown) => event),
        });
      },
    );
    const registry = {
      get: (name: string) => entries.get(name),
      registerComponent,
    };

    registerBuiltinComponents(registry);

    expect(registerComponent).toHaveBeenCalledTimes(4);
    expect(entries.get('Input')?.component).toBe(ProbeComponent);
    expect(entries.get('Fragment')).toBeDefined();
  });

  it('优先使用自定义 has，并安全忽略不可写注册表', () => {
    const registerComponent = vi.fn();
    const registry = {
      get: () => undefined,
      has: (name: string) => name === 'Table',
      registerComponent,
    };

    registerBuiltinComponents(registry);
    expect(registerComponent).toHaveBeenCalledTimes(4);
    expect(registerComponent.mock.calls.some(([name]) => name === 'Table')).toBe(false);
    expect(() => registerBuiltinComponents({ get: () => undefined })).not.toThrow();
  });
});

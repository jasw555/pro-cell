import { createElement, Fragment } from 'react';
import type * as React from 'react';
import {
  Input as AntInput,
  Select as AntSelect,
  Switch as AntSwitch,
  Table as AntTable,
} from 'antd';
import type { InputProps, SelectProps, SwitchProps, TableProps } from 'antd';
import type { ComponentAdapterOptions, ComponentRegistryLike, RegisteredComponent } from './types';
import { ReactComponentRegistry } from './registry';

type RuntimeProps = Record<string, unknown>;

/** 复制 props 并移除 children，避免 children 同时作为显式参数和属性传入。 */
function omitChildren(props: RuntimeProps): RuntimeProps {
  const rest = { ...props };
  delete rest.children;
  return rest;
}

/** `$comp: "Input"` 对应的 antd Input 适配组件。 */
export function InputComponent(props: RuntimeProps): React.ReactNode {
  return createElement(AntInput, omitChildren(props) as unknown as InputProps);
}

/** `$comp: "Select"` 对应的 antd Select 适配组件。 */
export function SelectComponent(props: RuntimeProps): React.ReactNode {
  return createElement(AntSelect, omitChildren(props) as unknown as SelectProps<unknown>);
}

/** `$comp: "Switch"` 对应的 antd Switch 适配组件，值属性为 checked。 */
export function SwitchComponent(props: RuntimeProps): React.ReactNode {
  return createElement(AntSwitch, omitChildren(props) as unknown as SwitchProps);
}

/**
 * `$comp: "Table"` 的 antd Table 直通适配器。
 * v1 不在这里引入分页、编辑单元格或行级字段路径，所有 columns/dataSource 等
 * 参数保持 antd 原生语义，以便后续版本按需扩展。
 */
export function TableComponent(props: RuntimeProps): React.ReactNode {
  return createElement(AntTable, omitChildren(props) as unknown as TableProps<unknown>);
}

/** 结构节点适配器：只组合 children，不产生额外 DOM。 */
export function FragmentComponent(props: RuntimeProps): React.ReactNode {
  return createElement(Fragment, null, props.children as React.ReactNode);
}

/** 内置组件及值适配规则的静态定义。 */
interface BuiltinDefinition {
  readonly name: string;
  readonly component: (props: RuntimeProps) => React.ReactNode;
  readonly options: ComponentAdapterOptions;
}

/**
 * 默认组件集合。
 * 定义保持不可变，registerBuiltinComponents 只在目标注册表缺失时写入，
 * 不会覆盖用户通过 override/自定义注册的实现。
 */
const builtins: readonly BuiltinDefinition[] = [
  {
    name: 'Input',
    component: InputComponent,
    options: {
      valueProp: 'value',
      eventToValue: (event: unknown) => {
        if (typeof event === 'object' && event !== null && 'target' in event) {
          const target = (event as { target?: unknown }).target;
          if (typeof target === 'object' && target !== null && 'value' in target) {
            return (target as { value?: unknown }).value;
          }
        }
        return event;
      },
    },
  },
  {
    name: 'Select',
    component: SelectComponent,
    options: { valueProp: 'value', eventToValue: (event: unknown) => event },
  },
  {
    name: 'Switch',
    component: SwitchComponent,
    options: {
      valueProp: 'checked',
      eventToValue: (event: unknown) => {
        if (typeof event === 'boolean') return event;
        if (typeof event === 'object' && event !== null && 'target' in event) {
          const target = (event as { target?: unknown }).target;
          if (typeof target === 'object' && target !== null && 'checked' in target) {
            return (target as { checked?: unknown }).checked;
          }
        }
        return event;
      },
    },
  },
  {
    name: 'Table',
    component: TableComponent,
    options: { valueProp: 'dataSource', eventToValue: (event: unknown) => event },
  },
  {
    name: 'Fragment',
    component: FragmentComponent,
    options: { valueProp: 'value', eventToValue: (event: unknown) => event },
  },
];

/**
 * 渲染器只读的内置组件索引。
 *
 * 索引在模块初始化时一次性生成，不写入用户注册表。这样 SchemaRenderer 在 React
 * render 阶段只做查询，不会因为补注册组件而产生外部可观察的副作用。用户注册表
 * 中的同名记录始终优先，只有查询不到时才回退到这里。
 */
const builtinEntries = new Map<string, RegisteredComponent>(
  builtins.map((builtin) => [
    builtin.name,
    Object.freeze({
      name: builtin.name,
      component: builtin.component,
      valueProp: builtin.options.valueProp ?? 'value',
      changeProp: builtin.options.changeProp ?? 'onChange',
      eventToValue: builtin.options.eventToValue ?? ((event: unknown) => event),
    }),
  ]),
);

/**
 * 读取一个内置组件适配记录，不修改任何注册表。
 * Map 查询平均时间复杂度 O(1)，返回对象在初始化后被冻结，可安全跨表单复用。
 */
export function getBuiltinComponent(name: string): RegisteredComponent | undefined {
  return builtinEntries.get(name);
}

/**
 * 显式把渲染器内置组件写入目标注册表；重复调用不会覆盖用户显式注册的组件。
 * SchemaRenderer 本身不会调用此函数；需要枚举或预注册组件时再显式调用。
 * 该函数兼容 core 风格的最小注册表协议，便于在不同包入口间复用；注册失败由
 * 注册表自行返回 Result，本层保持幂等并继续处理其余内置组件。
 */
export function registerBuiltinComponents(registry: ComponentRegistryLike): void {
  if (!(registry instanceof ReactComponentRegistry)) {
    const candidate = registry as unknown as {
      readonly has?: (name: string) => boolean;
      readonly registerComponent?: (
        name: string,
        component: React.ComponentType<RuntimeProps>,
        options?: ComponentAdapterOptions,
      ) => unknown;
    };
    if (candidate.registerComponent === undefined) return;
    for (const builtin of builtins) {
      // 部分自定义注册表只实现 `get`，因此同时兼容可选的 `has`。
      if (candidate.has?.(builtin.name) === true || registry.get(builtin.name) !== undefined) {
        continue;
      }
      candidate.registerComponent(builtin.name, builtin.component, builtin.options);
    }
    return;
  }
  for (const builtin of builtins) {
    if (!registry.has(builtin.name)) {
      registry.registerComponent(builtin.name, builtin.component, builtin.options);
    }
  }
}

/** 导出只读定义，供文档、调试和自定义注册表适配器检查。 */
export { builtins };

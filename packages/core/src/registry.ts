import type * as React from 'react';
import { err, ok, type Result } from '@jasw/pro-cell-shared';
import { ComponentNotFoundError, RegistryError } from '@jasw/pro-cell-shared';

/**
 * 将已注册组件发出的 change 事件转换成表单值。
 * 适配器位于泛型组件与无类型 Schema 边界之间，组件作者可以按自身事件形状提供实现。
 */
export type EventToValue = (event: unknown) => unknown;

/**
 * 控制组件值属性和事件适配的选项。
 * `override` 必须显式设为 true 才会替换已有注册，防止初始化顺序导致静默覆盖。
 */
export interface ComponentAdapterOptions {
  /** 受控值属性名，默认 `value`。 */
  readonly valueProp?: string;
  /** 变更回调属性名，默认 `onChange`。 */
  readonly changeProp?: string;
  /** 将组件事件提取为字段值的纯函数。 */
  readonly eventToValue?: EventToValue;
  /** 是否允许覆盖同名组件。 */
  readonly override?: boolean;
}

/**
 * SchemaParser/React 渲染器使用的运行时组件记录。
 * `component` 保留原始 React 引用；其余字段描述如何把 FormApi 状态注入组件。
 */
export interface RegisteredComponent {
  readonly name: string;
  readonly component: React.ComponentType<Record<string, unknown>>;
  readonly valueProp: string;
  readonly changeProp: string;
  readonly eventToValue: EventToValue;
}

/**
 * 判断运行时值是否可以作为 React 组件类型。
 *
 * 普通函数和类组件直接通过；`forwardRef`、`memo`、`lazy` 是带 `$$typeof`
 * 标记的对象。这里不接受普通对象，避免注册成功后才由 React 抛出
 * `Element type is invalid`。
 */
function isReactComponentType(value: unknown): boolean {
  if (typeof value === 'function') {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    const marker = Reflect.get(value, '$$typeof');
    return (
      marker === Symbol.for('react.forward_ref') ||
      marker === Symbol.for('react.memo') ||
      marker === Symbol.for('react.lazy')
    );
  } catch {
    return false;
  }
}

/**
 * 默认事件适配：优先读取 `target.checked`，其次读取 `target.value`，
 * 无法识别时原样返回事件。时间复杂度 O(1)，不会深度遍历用户对象。
 */
function defaultEventToValue(event: unknown): unknown {
  if (
    typeof event === 'object' &&
    event !== null &&
    'target' in event &&
    typeof event.target === 'object' &&
    event.target !== null &&
    ('value' in event.target || 'checked' in event.target)
  ) {
    return 'checked' in event.target ? event.target.checked : event.target.value;
  }
  return event;
}

/**
 * 在注册表内部收窄组件 Props。
 * 这是唯一进行泛型擦除的边界：React 最终接收的是 Schema 生成的动态对象，
 * 公共 register API 仍保留调用方的泛型约束，且不暴露 `any`。
 */
function asInternalComponent<P extends object>(
  component: React.ComponentType<P>,
): React.ComponentType<Record<string, unknown>> {
  // React 会使用 Schema 生成的动态 props 调用组件。类型擦除被限制在这个存在类型
  // 注册边界内；公共 API 仍保留泛型约束，并且不会向外暴露 `any`。
  return component as unknown as React.ComponentType<Record<string, unknown>>;
}

/**
 * 可变组件注册表，带单调递增版本号。
 * Map 查找、插入和删除平均为 O(1)；版本号供自定义缓存或调试工具判断内容是否变化。
 * 每个实例都独立保存组件，便于多租户、测试和 SSR 请求隔离。
 */
export class ComponentRegistry {
  private readonly components = new Map<string, RegisteredComponent>();
  private revision = 0;

  /**
   * 注册组件并配置值适配器。
   * 名称会 trim；重复名称在未显式 override 时返回 RegistryError，任何校验失败都不会
   * 改变现有条目。成功后 revision 加一，调用方可据此使自己的缓存失效。
   */
  public register<P extends object>(
    name: string,
    component: React.ComponentType<P>,
    options: ComponentAdapterOptions = {},
  ): Result<void, RegistryError> {
    if (typeof name !== 'string') {
      return err(new RegistryError('组件名称必须是字符串'));
    }
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      return err(new RegistryError('组件名称不能为空'));
    }
    if (!isReactComponentType(component)) {
      return err(new RegistryError(`组件 “${normalizedName}” 不是有效的 React 组件`));
    }
    let override: unknown;
    let valuePropOption: unknown;
    let changePropOption: unknown;
    let eventToValueOption: unknown;
    try {
      override = options.override;
      valuePropOption = options.valueProp;
      changePropOption = options.changeProp;
      eventToValueOption = options.eventToValue;
    } catch (cause: unknown) {
      return err(new RegistryError(`组件 “${normalizedName}” 的适配配置读取失败`, cause));
    }
    if (this.components.has(normalizedName) && override !== true) {
      return err(
        new RegistryError(`组件 “${normalizedName}” 已注册；如需覆盖请设置 override: true`),
      );
    }
    if (valuePropOption !== undefined && typeof valuePropOption !== 'string') {
      return err(new RegistryError(`组件 “${normalizedName}” 的 valueProp 必须是字符串`));
    }
    if (changePropOption !== undefined && typeof changePropOption !== 'string') {
      return err(new RegistryError(`组件 “${normalizedName}” 的 changeProp 必须是字符串`));
    }
    if (eventToValueOption !== undefined && typeof eventToValueOption !== 'function') {
      return err(new RegistryError(`组件 “${normalizedName}” 的 eventToValue 必须是函数`));
    }
    const valueProp = (valuePropOption as string | undefined)?.trim() || 'value';
    const changeProp = (changePropOption as string | undefined)?.trim() || 'onChange';
    const eventToValue =
      typeof eventToValueOption === 'function'
        ? (eventToValueOption as EventToValue)
        : defaultEventToValue;
    this.components.set(normalizedName, {
      name: normalizedName,
      component: asInternalComponent(component),
      valueProp,
      changeProp,
      eventToValue,
    });
    this.revision += 1;
    return ok(undefined);
  }

  /** 与公共便捷函数同名的兼容别名；行为与 `register` 完全一致。 */
  public registerComponent<P extends object>(
    name: string,
    component: React.ComponentType<P>,
    options: ComponentAdapterOptions = {},
  ): Result<void, RegistryError> {
    return this.register(name, component, options);
  }

  /** 查找组件但不抛异常；不存在时返回 undefined。时间复杂度 O(1)。 */
  public get(name: string): RegisteredComponent | undefined {
    return this.components.get(name);
  }

  /** 查找组件并将缺失转换为带路径信息的 ComponentNotFoundError。 */
  public resolve(name: string, path?: string): Result<RegisteredComponent, ComponentNotFoundError> {
    const component = this.get(name);
    return component ? ok(component) : err(new ComponentNotFoundError(name, path));
  }

  /** 删除组件注册；成功删除才递增版本号。时间复杂度 O(1)。 */
  public unregister(name: string): boolean {
    const removed = this.components.delete(name);
    if (removed) {
      this.revision += 1;
    }
    return removed;
  }

  /** 判断名称是否已注册。时间复杂度 O(1)。 */
  public has(name: string): boolean {
    return this.components.has(name);
  }

  /** 返回注册内容的单调版本号，供外部缓存和诊断使用。 */
  public getVersion(): number {
    return this.revision;
  }

  /** 返回当前条目的浅快照，供诊断和测试使用；不会暴露内部 Map。 */
  public entries(): readonly RegisteredComponent[] {
    return [...this.components.values()];
  }
}

/** 进程级默认注册表，便捷注册函数和默认解析器共享该实例。 */
export const defaultRegistry = new ComponentRegistry();

/** 向进程级默认注册表注册组件。 */
export function registerComponent<P extends object>(
  name: string,
  component: React.ComponentType<P>,
  options?: ComponentAdapterOptions,
): Result<void, RegistryError> {
  return defaultRegistry.register(name, component, options);
}

/** 创建隔离注册表，适合独立渲染器、SSR 请求或测试使用。 */
export function createComponentRegistry(): ComponentRegistry {
  return new ComponentRegistry();
}

/** 从指定注册表（未提供时使用默认注册表）查找组件。 */
export function getRegisteredComponent(
  registry: ComponentRegistry | undefined,
  name: string,
): RegisteredComponent | undefined {
  return (registry ?? defaultRegistry).get(name);
}

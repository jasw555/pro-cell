import type * as React from 'react';
import { err, ok } from '@jasw/pro-cell-shared';
import type { Result } from '@jasw/pro-cell-shared';
import { ComponentNotFoundError, RegistryError } from '@jasw/pro-cell-shared';
import type {
  ComponentAdapterOptions,
  ComponentRegistryLike,
  RegisterComponentApi,
  RegisteredComponent,
} from './types';

type ComponentProps = Record<string, unknown>;

/** 校验函数/类组件以及 React 的 forwardRef、memo、lazy 包装类型。 */
function isReactComponentType(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null) return false;
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
 * 默认 DOM/React 事件适配器。
 * antd Input 通常传入 `{ target: { value } }`，Switch 可能传入 checked；
 * 无法识别的自定义事件原样交给用户，以便通过显式 eventToValue 扩展。
 */
function defaultEventToValue(event: unknown): unknown {
  if (typeof event === 'object' && event !== null && 'target' in event) {
    const target = (event as { target?: unknown }).target;
    if (typeof target === 'object' && target !== null) {
      if ('value' in target) {
        return (target as { value?: unknown }).value;
      }
      if ('checked' in target) {
        return (target as { checked?: unknown }).checked;
      }
    }
  }
  return event;
}

/** Switch/checkbox 专用适配器，只读取 target.checked。 */
function checkedEventToValue(event: unknown): unknown {
  if (typeof event === 'object' && event !== null && 'target' in event) {
    const target = (event as { target?: unknown }).target;
    if (typeof target === 'object' && target !== null && 'checked' in target) {
      return (target as { checked?: unknown }).checked;
    }
  }
  return event;
}

/**
 * React 组件注册表。
 * 注册表只保存原始组件引用和适配元数据，渲染器负责注入字段运行时属性；
 * 因此注册表可在 SSR、多表单和测试之间隔离复用。Map 查找/注册平均 O(1)，
 * revision 递增，供自定义缓存或调试工具判断注册内容是否变化。
 */
export class ReactComponentRegistry implements ComponentRegistryLike, RegisterComponentApi {
  private readonly components = new Map<string, RegisteredComponent>();
  private revision = 0;

  /** 按名称读取记录；不存在时返回 undefined，不抛异常。 */
  public get(name: string): RegisteredComponent | undefined {
    return this.components.get(name);
  }

  /** 判断名称是否已注册。 */
  public has(name: string): boolean {
    return this.components.has(name);
  }

  /**
   * 注册一个 React 组件及其值适配规则。
   * 泛型只在这里的适配边界擦除；原始组件引用保持不变，便于 React DevTools、ref
   * 和静态属性继续工作。校验失败返回 RegistryError，且不会部分写入。
   */
  public registerComponent<P extends object>(
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
      return err(new RegistryError(`组件 ${normalizedName} 不是有效的 React 组件`));
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
      return err(new RegistryError(`组件 ${normalizedName} 的适配配置读取失败`, cause));
    }
    if (this.components.has(normalizedName) && override !== true) {
      return err(new RegistryError(`组件 ${normalizedName} 已注册`));
    }
    if (valuePropOption !== undefined && typeof valuePropOption !== 'string') {
      return err(new RegistryError(`组件 ${normalizedName} 的 valueProp 必须是字符串`));
    }
    if (changePropOption !== undefined && typeof changePropOption !== 'string') {
      return err(new RegistryError(`组件 ${normalizedName} 的 changeProp 必须是字符串`));
    }
    if (eventToValueOption !== undefined && typeof eventToValueOption !== 'function') {
      return err(new RegistryError(`组件 ${normalizedName} 的 eventToValue 必须是函数`));
    }

    // 泛型擦除只发生在适配边界；保留原始组件引用，便于 React DevTools、
    // ref/静态属性和 SchemaParser 的组件替换语义保持透明。
    const adapted = component as unknown as React.ComponentType<ComponentProps>;
    const valueProp = (valuePropOption as string | undefined)?.trim() || 'value';
    const changeProp = (changePropOption as string | undefined)?.trim() || 'onChange';
    const eventToValue =
      typeof eventToValueOption === 'function'
        ? (eventToValueOption as (event: unknown) => unknown)
        : valueProp === 'checked'
          ? checkedEventToValue
          : defaultEventToValue;
    this.components.set(normalizedName, {
      name: normalizedName,
      component: adapted,
      valueProp,
      changeProp,
      eventToValue,
    });
    this.revision += 1;
    return ok(undefined);
  }

  /** 与 core ComponentRegistry 保持兼容的注册别名。 */
  public register<P extends object>(
    name: string,
    component: React.ComponentType<P>,
    options: ComponentAdapterOptions = {},
  ): Result<void, RegistryError> {
    return this.registerComponent(name, component, options);
  }

  /** 解析组件并把缺失名称转换成带路径的 ComponentNotFoundError。 */
  public resolve(name: string, path?: string): Result<RegisteredComponent, ComponentNotFoundError> {
    const component = this.get(name);
    return component === undefined
      ? { ok: false, error: new ComponentNotFoundError(name, path) }
      : { ok: true, value: component };
  }

  /** 删除组件并递增版本；删除不存在名称返回 false。 */
  public unregister(name: string): boolean {
    const removed = this.components.delete(name);
    if (removed) this.revision += 1;
    return removed;
  }

  /** 返回注册表修订号，供缓存/调试使用。 */
  public getVersion(): number {
    return this.revision;
  }

  /** 返回条目浅快照，调用方修改数组不会影响注册表。 */
  public entries(): readonly RegisteredComponent[] {
    return [...this.components.values()];
  }
}

/** 进程级 React 默认注册表；React 入口初始化时会注册内置组件。 */
export const defaultRegistry = new ReactComponentRegistry();

/** 创建不与默认注册表共享状态的 React 注册表。 */
export function createComponentRegistry(): ReactComponentRegistry {
  return new ReactComponentRegistry();
}

/** 向进程级默认注册表注册组件。 */
export function registerComponent<P extends object>(
  name: string,
  component: React.ComponentType<P>,
  options: ComponentAdapterOptions = {},
): Result<void, RegistryError> {
  return defaultRegistry.registerComponent(name, component, options);
}

/** 从指定/默认注册表读取组件，不改变注册表状态。 */
export function getRegisteredComponent(
  registry: ComponentRegistryLike | undefined,
  name: string,
): RegisteredComponent | undefined {
  return (registry ?? defaultRegistry).get(name);
}

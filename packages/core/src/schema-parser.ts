import { createElement, Fragment } from 'react';
import type * as React from 'react';
import {
  ComponentNotFoundError,
  SchemaParseError,
  err,
  ok,
  type JsonRecord,
  type NormalizedSchemaNode,
  type Result,
  type SchemaNode,
  cloneSchemaValue,
  isSchemaNode,
} from '@jasw/pro-cell-shared';
import { ComponentRegistry, defaultRegistry, type RegisteredComponent } from './registry';

/**
 * `$comp` Schema 到 React 虚拟节点的纯解析层。
 * 本模块只负责静态 AST 规范化、组件解析和 children 组合；动态字段状态由
 * `packages/react` 渲染器注入，避免把可变表单值写入缓存。
 */

/**
 * 渲染器可选的运行时上下文。
 * `resolveProps` 在每个节点创建元素前调用，用于注入动态属性；其它字段仅作为
 * 上层适配器的扩展槽，不会被解析器解释。registry 未提供时使用构造函数注册表。
 */
export interface SchemaRenderContext {
  readonly registry?: ComponentRegistry;
  /** 当前递归节点路径，用于错误诊断和稳定 key。 */
  readonly path?: string;
  /** 追加到 React key 前的前缀，用于嵌套 Fragment 隔离。 */
  readonly keyPrefix?: string;
  /** 为解析回调或自定义渲染器保留的上下文。 */
  readonly values?: JsonRecord;
  readonly form?: unknown;
  readonly resolveProps?: (node: NormalizedSchemaNode, path: string) => JsonRecord;
  /** 允许框架适配器携带额外的运行时数据（这些数据不属于 Schema 协议）。 */
  readonly [key: string]: unknown;
}

/** 解析结果，同时保留规范化 AST，便于依赖分析、诊断和自定义渲染器复用。 */
export interface ParsedSchema {
  /** 经过深拷贝与冻结的静态节点树。 */
  readonly node: NormalizedSchemaNode;
  /** 由该 AST 生成的 React 虚拟节点。 */
  readonly element: React.ReactNode;
}

/**
 * 将 `$comp` 节点转换为 React 虚拟节点。
 *
 * 静态规范化结果使用 WeakMap 记忆化。缓存与 ReactElement 分离，避免动态表单值
 * 和 key 过期；缓存未命中时遍历 N 个节点，时间复杂度为 O(N)。
 */
export class SchemaParser {
  private readonly cache = new WeakMap<object, NormalizedSchemaNode>();
  private readonly registry: ComponentRegistry;

  /** 创建绑定到指定注册表的解析器；同一解析器可复用多个静态 Schema。 */
  public constructor(registry: ComponentRegistry = defaultRegistry) {
    this.registry = registry;
  }

  /**
   * 解析对象或 JSON 字符串并返回 React 节点。
   * JSON 解析、结构校验和组件缺失均通过 Result 返回；递归渲染复杂度 O(N)，N 为节点数。
   */
  public parse(
    input: SchemaNode | string,
    context: SchemaRenderContext = {},
  ): Result<React.ReactNode, SchemaParseError | ComponentNotFoundError> {
    const normalized = this.normalize(input);
    if (!normalized.ok) {
      return normalized;
    }
    return this.renderNode(normalized.value, {
      ...context,
      registry: context.registry ?? this.registry,
    });
  }

  /**
   * 解析 Schema，失败时抛出对应的领域错误。
   * 适合 React render 边界；命令式调用若不希望异常应使用 `parse`。
   */
  public parseOrThrow(
    input: SchemaNode | string,
    context: SchemaRenderContext = {},
  ): React.ReactNode {
    const result = this.parse(input, context);
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  /**
   * 只执行规范化并暴露 AST，供 DependencyTracker 等上层模块分析依赖。
   * 对象输入通过 WeakMap 缓存，缓存键不会阻止调用方对象被垃圾回收。
   */
  public normalize(input: SchemaNode | string): Result<NormalizedSchemaNode, SchemaParseError> {
    let candidate: unknown = input;
    if (typeof input === 'string') {
      try {
        candidate = JSON.parse(input) as unknown;
      } catch (cause: unknown) {
        return err(new SchemaParseError('Schema JSON 解析失败', cause));
      }
    }
    // 对象输入先查 WeakMap：缓存命中时直接复用不可变 AST，避免再次递归读取
    // 调用方对象的 getter/children。缓存保存的是静态定义，因此调用方应把 Schema
    // 视为不可变值；组件引用仍会在 renderNode 中从当前 registry 重新解析。
    if (typeof candidate === 'object' && candidate !== null) {
      const cached = this.cache.get(candidate);
      if (cached !== undefined) {
        return ok(cached);
      }
    }
    try {
      if (!isSchemaNode(candidate)) {
        return err(new SchemaParseError('Schema 必须是包含非空 $comp 字段的对象'));
      }
      return ok(this.normalizeNode(candidate, new WeakSet<object>()));
    } catch (cause: unknown) {
      if (cause instanceof SchemaParseError) {
        return err(cause);
      }
      return err(new SchemaParseError('Schema 规范化失败', cause));
    }
  }

  /**
   * 同时返回 React 节点和规范化 AST，适合先注册联动、再渲染的场景。
   * 元素本身不写入缓存，因此动态 key/属性不会过期。
   */
  public parseWithAst(
    input: SchemaNode | string,
    context: SchemaRenderContext = {},
  ): Result<ParsedSchema, SchemaParseError | ComponentNotFoundError> {
    const normalized = this.normalize(input);
    if (!normalized.ok) {
      return normalized;
    }
    const element = this.renderNode(normalized.value, {
      ...context,
      registry: context.registry ?? this.registry,
    });
    return element.ok ? ok({ node: normalized.value, element: element.value }) : element;
  }

  /**
   * 深度规范化单个节点并填充 WeakMap。
   * ancestors 只表示当前递归路径，用于识别真实循环而不误伤兄弟节点共享引用；
   * 先命中缓存再递归可将重复引用的成本降到 O(1)。
   */
  private normalizeNode(node: SchemaNode, ancestors: WeakSet<object>): NormalizedSchemaNode {
    if (ancestors.has(node)) {
      throw new SchemaParseError('Schema children 不能包含循环引用');
    }
    // 缓存命中时不再读取调用方对象的 getter；规范化 AST 已经冻结，可直接复用。
    // 祖先检查必须先于缓存检查，避免一个已缓存对象在新的递归路径中掩盖真实环。
    const cached = this.cache.get(node);
    if (cached) {
      return cached;
    }
    if (node.name !== undefined && node.name.trim().length === 0) {
      throw new SchemaParseError('Schema 字段 name 不能为空');
    }
    if (
      (node.rules !== undefined && node.rules.length > 0) ||
      (node.reactions !== undefined && node.reactions.length > 0)
    ) {
      if (node.name === undefined || node.name.trim().length === 0) {
        throw new SchemaParseError('包含 rules 或 reactions 的字段必须提供稳定 name');
      }
    }
    ancestors.add(node);
    // children 先规范化，确保下游 renderer 始终得到冻结数组和稳定顺序。
    const normalizedChildren = (node.children ?? []).map((child) =>
      this.normalizeNode(child, ancestors),
    );
    ancestors.delete(node);
    const normalized = Object.freeze({
      ...node,
      props: cloneSchemaValue(node.props ?? {}) as JsonRecord,
      children: Object.freeze(normalizedChildren),
      rules: cloneSchemaValue([...(node.rules ?? [])]) as NormalizedSchemaNode['rules'],
      reactions: cloneSchemaValue([...(node.reactions ?? [])]) as NormalizedSchemaNode['reactions'],
    });
    this.cache.set(node, normalized);
    return normalized;
  }

  /**
   * 递归创建 React 元素。
   * Fragment 不经过注册表，直接组合 children；普通节点每次从当前 registry 解析
   * 组件，保证 override/unregister 在下一次解析立即生效。时间复杂度 O(N)。
   */
  private renderNode(
    node: NormalizedSchemaNode,
    context: SchemaRenderContext,
    index = 0,
  ): Result<React.ReactNode, SchemaParseError | ComponentNotFoundError> {
    const path = context.path ?? node.name ?? String(index);
    const keyPrefix = context.keyPrefix ?? '';
    const key = `${keyPrefix}${path}`;
    if (node.$comp === 'Fragment') {
      // key 使用完整路径，避免嵌套 Fragment 中同名字段发生 React key 冲突。
      const children: React.ReactNode[] = [];
      for (let childIndex = 0; childIndex < node.children.length; childIndex += 1) {
        const child = node.children[childIndex];
        /* c8 ignore next 2 -- normalized schema children are validated before rendering. */
        if (!child) {
          continue;
        }
        const childPath = child.name ?? `${path}.${childIndex}`;
        const rendered = this.renderNode(
          child,
          {
            ...context,
            path: childPath,
            keyPrefix: `${keyPrefix}${path}.`,
          },
          childIndex,
        );
        if (!rendered.ok) {
          return rendered;
        }
        children.push(rendered.value);
      }
      return ok(createElement(Fragment, { key }, ...children));
    }
    const registry = context.registry ?? this.registry;
    const resolved = this.resolveComponent(node, registry, path);
    if (!resolved.ok) {
      return resolved;
    }
    let suppliedProps: JsonRecord = {};
    try {
      suppliedProps = context.resolveProps?.(node, path) ?? {};
    } catch (cause: unknown) {
      return err(new SchemaParseError(`组件 “${node.$comp}” 属性解析失败`, cause));
    }
    let props: Record<string, unknown>;
    try {
      props = {
        ...node.props,
        ...suppliedProps,
      };
    } catch (cause: unknown) {
      return err(new SchemaParseError(`组件 “${node.$comp}” 属性复制失败`, cause));
    }
    // 子节点失败时立即返回，不创建不完整的 React 树。
    const children: React.ReactNode[] = [];
    for (let childIndex = 0; childIndex < node.children.length; childIndex += 1) {
      const child = node.children[childIndex];
      /* c8 ignore next 2 -- normalized schema children are validated before rendering. */
      if (!child) {
        continue;
      }
      const childPath = child.name ?? `${path}.${childIndex}`;
      const rendered = this.renderNode(
        child,
        {
          ...context,
          path: childPath,
          keyPrefix: `${keyPrefix}${path}.`,
        },
        childIndex,
      );
      if (!rendered.ok) {
        return rendered;
      }
      children.push(rendered.value);
    }

    try {
      return ok(createElement(resolved.value.component, { ...props, key }, ...children));
    } catch (cause: unknown) {
      /* c8 ignore next 3 -- React's createElement validates the component before returning. */
      return err(new SchemaParseError(`组件 “${node.$comp}” 创建虚拟节点失败`, cause));
    }
  }

  /** 将注册表抛出的未知异常重新封装为 SchemaParseError。 */
  private resolveComponent(
    node: NormalizedSchemaNode,
    registry: ComponentRegistry,
    path: string,
  ): Result<RegisteredComponent, ComponentNotFoundError | SchemaParseError> {
    try {
      return registry.resolve(node.$comp, path);
    } catch (cause: unknown) {
      return err(new SchemaParseError(`组件注册表解析 “${node.$comp}” 失败`, cause));
    }
  }
}

/** 使用进程级默认注册表的便捷解析器实例。 */
export const defaultSchemaParser = new SchemaParser(defaultRegistry);

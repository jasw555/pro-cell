import { SchemaParser as CoreSchemaParser } from './core';
import { defaultRegistry as reactDefaultRegistry } from './react-entry';
import type { ComponentRegistry as CoreComponentRegistry } from './core';
import type { ParsedSchema, SchemaRenderContext as CoreSchemaRenderContext } from './core';
import type { ReactComponentRegistry } from './react-entry';
import type * as React from 'react';
import type { ComponentNotFoundError, Result, SchemaNode, SchemaParseError } from './shared';

/**
 * `@jasw/pro-cell` 的聚合入口。
 * 该包把 core、react、shared 的实现打进同一个发布产物；下面的类型别名和转发导出
 * 只负责保持单包 API 一致，不创建第二套状态或注册表。
 */
export type PublicSchemaRegistry = CoreComponentRegistry | ReactComponentRegistry;

/** 根入口解析器可接受的 React/core 注册表上下文。 */
export interface PublicSchemaRenderContext extends Omit<CoreSchemaRenderContext, 'registry'> {
  readonly registry?: PublicSchemaRegistry;
}

/** 根入口渲染上下文，允许 React 或 core 注册表。 */
export type SchemaRenderContext = PublicSchemaRenderContext;

/**
 * 根入口使用 React 注册表作为默认注册表，让 `registerComponent`、内置组件
 * 与低层 SchemaParser 在单包用法下保持一致；`@jasw/pro-cell/core` 仍保留
 * 完全独立的无 UI 注册表。
 */
export class SchemaParser extends CoreSchemaParser {
  /** 默认绑定 React 注册表，以便 root 入口注册的组件可立即用于渲染。 */
  public constructor(registry?: PublicSchemaRegistry) {
    super((registry ?? reactDefaultRegistry) as unknown as CoreComponentRegistry);
  }

  /** 转发 core parse，并放宽 registry 参数为 root 入口联合类型。 */
  public override parse(
    input: SchemaNode | string,
    context: PublicSchemaRenderContext = {},
  ): Result<React.ReactNode, SchemaParseError | ComponentNotFoundError> {
    return super.parse(input, context as CoreSchemaRenderContext);
  }

  /** 转发 parseOrThrow，保留领域错误的抛出语义。 */
  public override parseOrThrow(
    input: SchemaNode | string,
    context: PublicSchemaRenderContext = {},
  ): React.ReactNode {
    return super.parseOrThrow(input, context as CoreSchemaRenderContext);
  }

  /** 转发 parseWithAst，供 root 消费者同时取得 AST 和 React 节点。 */
  public override parseWithAst(
    input: SchemaNode | string,
    context: PublicSchemaRenderContext = {},
  ): Result<ParsedSchema, SchemaParseError | ComponentNotFoundError> {
    return super.parseWithAst(input, context as CoreSchemaRenderContext);
  }
}

/** root 入口共享的默认解析器；组件通过 registerComponent 注册到同一默认表。 */
export const defaultSchemaParser = new SchemaParser();

export * from './react-entry';
export { ReactComponentRegistry as ComponentRegistry } from './react-entry';
export {
  DependencyTracker,
  compileExpression,
  evaluateExpression,
  evaluateActionValue,
  isExpressionTemplate,
  actionDependencies,
  parseExpression,
  ComponentRegistry as CoreComponentRegistry,
  defaultRegistry as coreDefaultRegistry,
  createComponentRegistry as createCoreComponentRegistry,
  registerComponent as registerCoreComponent,
} from './core';
export type {
  ComponentAdapterOptions as CoreComponentAdapterOptions,
  DependencyEvent,
  DependencyListener,
  DependencyTrackerOptions,
  SchemaRenderContext as CoreSchemaRenderContext,
  ParsedSchema,
} from './core';
export {
  ok,
  err,
  isOk,
  isErr,
  map,
  flatMap,
  unwrapOr,
  tryCatch,
  ProCellError,
  SchemaParseError,
  ComponentNotFoundError,
  RegistryError,
  ExpressionError,
  DependencyCycleError,
  ReactionExecutionError,
  ValidationError,
  ValidationEngineError,
  FormSubmitError,
  AbortError,
  required,
  maxLength,
  pattern,
  isEmptyValue,
  validateBuiltInRule,
  runValidator,
  combineSignals,
  createCombinedController,
  cloneSchemaValue,
  validateValue,
  validateValueSync,
  isJsonRecord,
  isSchemaNode,
  isValidationRuleConfig,
  isReactionActions,
  isReactionConfig,
  normalizeSchemaNode,
  splitPath,
  normalizePath,
  getPathValue,
  setPathValue,
  toError,
} from './shared';
export type {
  Result,
  Ok,
  Err,
  JsonRecord,
  ProCellErrorCode,
  ExpressionSource,
  RequiredRule,
  MaxLengthRule,
  PatternRule,
  CustomRule,
  NormalizedSchemaNode,
  CompiledExpression,
  ValidatorContext,
  ValidatorRegistry,
  ValidationResult as RuleValidationResult,
  FormValidationResult as SharedFormValidationResult,
  SubmitResult as SharedSubmitResult,
  FieldState as SharedFieldState,
} from './shared';

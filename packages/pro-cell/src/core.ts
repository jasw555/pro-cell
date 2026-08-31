/**
 * `@jasw/pro-cell/core` 子路径。
 * 这是同一 `@jasw/pro-cell` 发布包的模块化入口，导出解析器、表达式和
 * DependencyTracker，但不引入 antd、Zustand 表单运行时。错误与 Result 也从这里转发，
 * 消费者不需要知道仓库内部 workspace 的名称。
 */
export * from '@jasw/pro-cell-core';
// Core 调用方通常需要立即处理解析结果，因此同一入口也提供 Result 和领域错误。
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
} from '@jasw/pro-cell-shared';
export type {
  Result,
  Ok,
  Err,
  JsonRecord,
  SchemaNode,
  NormalizedSchemaNode,
  ReactionActions,
  ReactionConfig,
  ValidationRuleConfig,
  CompiledExpression,
} from '@jasw/pro-cell-shared';

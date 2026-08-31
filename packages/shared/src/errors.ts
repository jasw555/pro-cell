/**
 * ProCell 公共 API 使用的稳定错误码。
 *
 * 错误码是跨包、跨运行时边界的机器可读约定；文案可以本地化或调整，
 * 但调用方应优先根据 `code` 和具体错误类进行分支处理。
 */
export type ProCellErrorCode =
  | 'SCHEMA_PARSE_ERROR'
  | 'COMPONENT_NOT_FOUND'
  | 'REGISTRY_ERROR'
  | 'EXPRESSION_ERROR'
  | 'DEPENDENCY_CYCLE'
  | 'REACTION_EXECUTION_ERROR'
  | 'VALIDATION_ERROR'
  | 'VALIDATION_ENGINE_ERROR'
  | 'FORM_SUBMIT_ERROR'
  | 'ABORT_ERROR';

/**
 * 所有领域错误的基类。
 * `cause` 保留底层异常，`details` 保存可序列化诊断信息；两者都不参与
 * 控制流判断。构造函数显式修复原型链，确保跨转译目标使用 `instanceof` 仍可靠。
 */
export class ProCellError extends Error {
  public readonly code: ProCellErrorCode;
  public override readonly cause: unknown | undefined;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: ProCellErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.name = 'ProCellError';
    this.code = code;
    this.cause = options?.cause;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 表示 JSON 无法解析，或 `$comp` 节点不符合协议。 */
export class SchemaParseError extends ProCellError {
  public constructor(message: string, cause?: unknown) {
    super('SCHEMA_PARSE_ERROR', message, { cause });
    this.name = 'SchemaParseError';
  }
}

/** 表示 Schema 引用了当前注册表中不存在的组件。 */
export class ComponentNotFoundError extends ProCellError {
  public readonly componentName: string;

  public constructor(componentName: string, path?: string) {
    super(
      'COMPONENT_NOT_FOUND',
      `组件 “${componentName}” 未注册${path ? `（路径：${path}）` : ''}`,
      { details: { componentName, path } },
    );
    this.name = 'ComponentNotFoundError';
    this.componentName = componentName;
  }
}

/** 表示组件注册名称、组件值或值适配器配置无效。 */
export class RegistryError extends ProCellError {
  public constructor(message: string, cause?: unknown) {
    super('REGISTRY_ERROR', message, { cause });
    this.name = 'RegistryError';
  }
}

/** 表示联动表达式语法不受支持、依赖路径不安全或求值失败。 */
export class ExpressionError extends ProCellError {
  public readonly expression: string;
  public readonly position: number | undefined;

  public constructor(expression: string, message: string, position?: number, cause?: unknown) {
    super('EXPRESSION_ERROR', message, {
      cause,
      details: { expression, position },
    });
    this.name = 'ExpressionError';
    this.expression = expression;
    this.position = position;
  }
}

/** 表示联动依赖图存在环；`cycle` 保存可读的首尾闭合路径。 */
export class DependencyCycleError extends ProCellError {
  public readonly cycle: readonly string[];

  public constructor(cycle: readonly string[]) {
    const rendered = cycle.join(' -> ');
    super('DEPENDENCY_CYCLE', `检测到联动依赖循环：${rendered}`, {
      details: { cycle: [...cycle] },
    });
    this.name = 'DependencyCycleError';
    this.cycle = [...cycle];
  }
}

/** 表示联动动作执行、订阅回调或外部状态适配失败。 */
export class ReactionExecutionError extends ProCellError {
  public readonly field: string | undefined;

  public constructor(message: string, field?: string, cause?: unknown) {
    super('REACTION_EXECUTION_ERROR', message, {
      cause,
      details: { field },
    });
    this.name = 'ReactionExecutionError';
    this.field = field;
  }
}

/** 表示单条校验规则未通过；`field` 和 `rule` 用于 UI 定位与诊断。 */
export class ValidationError extends ProCellError {
  public readonly field: string | undefined;
  public readonly rule: string | undefined;

  public constructor(
    message: string,
    options?: {
      readonly field?: string | undefined;
      readonly rule?: string | undefined;
      readonly cause?: unknown;
    },
  ) {
    super('VALIDATION_ERROR', message, {
      cause: options?.cause,
      details: { field: options?.field, rule: options?.rule },
    });
    this.name = 'ValidationError';
    this.field = options?.field;
    this.rule = options?.rule;
  }
}

/** 表示自定义校验器返回非法结果或校验引擎内部发生异常。 */
export class ValidationEngineError extends ProCellError {
  public constructor(message: string, cause?: unknown) {
    super('VALIDATION_ENGINE_ERROR', message, { cause });
    this.name = 'ValidationEngineError';
  }
}

/** 表示提交回调抛出异常或提交流程无法继续。 */
export class FormSubmitError extends ProCellError {
  public constructor(message: string, cause?: unknown) {
    super('FORM_SUBMIT_ERROR', message, { cause });
    this.name = 'FormSubmitError';
  }
}

/** 表示操作由 `AbortSignal`、重置、销毁或更新后的新任务取消。 */
export class AbortError extends ProCellError {
  public constructor(message = '操作已取消', cause?: unknown) {
    super('ABORT_ERROR', message, { cause });
    this.name = 'AbortError';
  }
}

/**
 * 将 `catch (cause: unknown)` 捕获的任意值转换为稳定的 `Error`。
 * 只有已有 `Error` 和字符串会保留原始信息，其余值使用统一兜底文案，
 * 避免把对象直接拼接到错误消息中造成不可预测输出。
 */
export function toError(cause: unknown, fallbackMessage = '未知错误'): Error {
  if (cause instanceof Error) {
    return cause;
  }
  if (typeof cause === 'string') {
    return new Error(cause);
  }
  return new Error(fallbackMessage);
}

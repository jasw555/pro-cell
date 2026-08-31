import type * as React from 'react';
import type {
  FormSubmitError,
  ProCellError,
  RegistryError,
  ReactionActions,
  ReactionConfig,
  Result,
  SchemaNode,
  ValidationRuleConfig,
  Validator,
} from '@jasw/pro-cell-shared';

/**
 * 可被取消的异步操作选项。
 * 调用方取消 signal 后，校验/提交会返回 `cancelled` 或 `AbortError`，且不会把取消
 * 当作普通字段错误展示。
 */
export interface AsyncOptions {
  /** 外部取消信号；可与 FormApi 的内部生命周期 signal 组合。 */
  readonly signal?: AbortSignal;
}

/** 一个字段在表单运行时的完整只读状态。 */
export interface FieldState {
  /** 当前值；隐藏字段也会保留。 */
  readonly value: unknown;
  /** 第一条错误文案，方便 Form.Item 直接展示。 */
  readonly error: string | undefined;
  /** 所有错误文案，按规则顺序排列。 */
  readonly errors: readonly string[];
  /** 是否渲染该字段。 */
  readonly visible: boolean;
  /** 是否向组件传递 disabled。 */
  readonly disabled: boolean;
  /** 是否有最新异步校验运行中。 */
  readonly validating: boolean;
  /** 是否由用户输入或显式 setValue 触碰。 */
  readonly touched: boolean;
}

/**
 * Zustand vanilla store 的不可变快照。
 * version 作为单调递增的缓存键，React `useSyncExternalStore` 可据此避免重复复制快照。
 */
export interface FormStateSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
  readonly fields: Readonly<Record<string, FieldState>>;
  readonly version: number;
}

/** 单个字段的公开校验结果；取消不生成普通错误。 */
export interface ValidationResult {
  /** 字段是否通过全部声明规则。 */
  readonly valid: boolean;
  /** 被校验的字段路径。 */
  readonly field: string;
  /** 可展示错误文案。 */
  readonly errors: readonly string[];
  /** 是否因 signal/新任务而取消。 */
  readonly cancelled?: boolean;
}

/** 整张表单的校验聚合结果，同时保留每个字段明细。 */
export interface FormValidationResult {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, readonly string[]>>;
  readonly fields: Readonly<Record<string, ValidationResult>>;
  readonly cancelled?: boolean;
}

/**
 * 提交结果判别联合。
 * 成功分支包含 `value`；失败分支包含领域错误，校验失败时附带 validation。
 */
export type SubmitResult<T = unknown> =
  | {
      readonly ok: true;
      readonly submitted: true;
      readonly value: T;
      readonly validation: FormValidationResult;
    }
  | {
      readonly ok: false;
      readonly submitted: false;
      readonly error: ProCellError | FormSubmitError;
      readonly validation?: FormValidationResult;
    };

/** 传给 onSubmit 的提交上下文。 */
export interface FormSubmitContext {
  /** 提交级别 signal；远程请求应传给 fetch 等 API。 */
  readonly signal: AbortSignal;
  /** 当前独立表单实例。 */
  readonly form: FormApi;
}

/** 用户提交回调；同步返回值和 Promise 均被统一处理。 */
export type FormSubmitHandler<T = unknown> = (
  values: Readonly<Record<string, unknown>>,
  context: FormSubmitContext,
) => T | Promise<T>;

/**
 * 创建一个独立表单实例的配置。
 * 每次 createForm/useForm 都建立自己的 Zustand store、DependencyTracker 和取消控制器，
 * 不会与其它表单共享运行时值。
 */
export interface FormOptions<TSubmit = unknown> {
  /** 可选 `$comp` Schema，用于收集字段规则和联动。 */
  readonly schema?: SchemaNode | string;
  /** 初始字段值。 */
  readonly initialValues?: Readonly<Record<string, unknown>>;
  /** custom 校验器注册表。 */
  readonly validators?: Readonly<Record<string, Validator>>;
  /** 通过校验后调用的提交回调。 */
  readonly onSubmit?: FormSubmitHandler<TSubmit>;
  /** 组件注册表；未提供时使用默认注册表。 */
  readonly registry?: ComponentRegistryLike;
  /** reaction 事务最大深度，默认由实现设定。 */
  readonly maxReactionDepth?: number;
}

/** 表单状态变化监听器；接收不可变快照。 */
export type FormListener = (snapshot: FormStateSnapshot) => void;
/** 取消表单或字段订阅的函数。 */
export type Unsubscribe = () => void;

/**
 * 基于隔离 vanilla Zustand store 的命令式表单 API。
 * 值和状态的读写为 O(1)；校验与联动成本随声明规则数和受影响依赖字段数增长。
 */
export interface FormApi<TSubmit = unknown> {
  /** 按点号路径读取字段值，复杂度 O(1)。 */
  getValue(path: string): unknown;
  /** 返回当前值的浅快照，不暴露内部 Zustand 对象。 */
  getValues(): Readonly<Record<string, unknown>>;
  /** 设置单个值并触发依赖级联。 */
  setValue(path: string, value: unknown): Result<void, ProCellError>;
  /** 批量设置值；同一批内 reaction 覆盖后的最终值具有优先级。 */
  setValues(values: Readonly<Record<string, unknown>>): Result<void, ProCellError>;
  /** 设置可见性；隐藏不会清除字段值。 */
  setVisible(path: string, visible: boolean): Result<void, ProCellError>;
  /** 设置禁用状态；只影响渲染属性。 */
  setDisabled(path: string, disabled: boolean): Result<void, ProCellError>;
  /** 读取字段完整状态的不可变副本。 */
  getFieldState(path: string): FieldState;
  /**
   * 验证单字段。新运行会取消同字段旧运行；由于自定义校验器可读取
   * 整份 values，校验期间任意字段值变化也会取消当前结果。
   */
  validateField(path: string, options?: AsyncOptions): Promise<ValidationResult>;
  /** 并行验证所有已知字段。 */
  validate(options?: AsyncOptions): Promise<FormValidationResult>;
  /** 验证通过后调用 onSubmit，并支持提交级取消。 */
  submit(options?: AsyncOptions): Promise<SubmitResult<TSubmit>>;
  /** 取消未完成任务并恢复初始/指定值，同时重新计算 reaction。 */
  reset(values?: Readonly<Record<string, unknown>>): Result<void, ProCellError>;
  /** 订阅高层快照；监听器异常会被封装为 ReactionExecutionError。 */
  subscribe(listener: FormListener): Unsubscribe;
  /** 释放 store、tracker、监听器和所有 AbortController。 */
  dispose(): void;
  /**
   * React renderer 使用的低层快照订阅接口（可选扩展）。
   *
   * 这些成员不是 FormApi 命令式公共契约的一部分；第三方实现只需实现上方
   * 的基础方法即可。内置 createForm 会提供它们，SchemaRenderer 在缺失时
   * 自动回退到 subscribe/getValues，并使用默认组件注册表。
   */
  readonly subscribeSnapshot?: (listener: () => void) => Unsubscribe;
  readonly getSnapshot?: () => FormStateSnapshot;
  readonly getSchema?: () => SchemaNode | undefined;
  readonly getRegistry?: () => ComponentRegistryLike;
}

/** 注册外部组件时的值/事件适配选项。 */
export interface ComponentAdapterOptions {
  /** 受控值属性名，默认 value。 */
  readonly valueProp?: string;
  /** 事件回调属性名，默认 onChange。 */
  readonly changeProp?: string;
  /** 从事件中提取字段值的函数。 */
  readonly eventToValue?: (event: unknown) => unknown;
  /** 显式允许覆盖同名组件。 */
  readonly override?: boolean;
}

/** 注册表中供渲染器使用的组件记录。 */
export interface RegisteredComponent {
  readonly name?: string;
  readonly component: React.ComponentType<Record<string, unknown>>;
  readonly valueProp: string;
  readonly changeProp?: string;
  readonly eventToValue: (event: unknown) => unknown;
}

/** 渲染器所需的最小注册表协议，便于传入自定义实现。 */
export interface ComponentRegistryLike {
  get(name: string): RegisteredComponent | undefined;
  has?(name: string): boolean;
}

/** 暴露 registerComponent 的对象协议。 */
export interface RegisterComponentApi {
  registerComponent<P extends object>(
    name: string,
    component: React.ComponentType<P>,
    options?: ComponentAdapterOptions,
  ): Result<void, RegistryError>;
}

/** SchemaRenderer 属性。 */
export interface SchemaRendererProps {
  /** `$comp` 对象或 JSON 字符串。 */
  readonly schema: SchemaNode | string;
  /** 可选外部表单；不传则从上下文或内部创建。 */
  readonly form?: FormApi;
  /** 包裹渲染树的 className。 */
  readonly className?: string;
}

/** SchemaForm 属性；负责创建 Form、Context 和 antd Form 外壳。 */
export interface SchemaFormProps<TSubmit = unknown> extends SchemaRendererProps {
  /** createForm 的配置（schema 字段由外层属性提供）。 */
  readonly options?: Omit<FormOptions<TSubmit>, 'schema'>;
  /** 覆盖 options.onSubmit 的提交回调。 */
  readonly onSubmit?: FormSubmitHandler<TSubmit>;
  /** 自定义内容；未提供时自动渲染 SchemaRenderer。 */
  readonly children?: React.ReactNode;
}

export type { ReactionActions, ReactionConfig, SchemaNode, ValidationRuleConfig, Validator };

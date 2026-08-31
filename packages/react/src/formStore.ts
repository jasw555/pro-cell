import { createStore } from 'zustand/vanilla';
import { err, normalizeSchemaNode, ok, validateValue } from '@jasw/pro-cell-shared';
import type { ProCellError, Result, SchemaNode, ValidationRuleConfig } from '@jasw/pro-cell-shared';
import {
  AbortError,
  FormSubmitError,
  ReactionExecutionError,
  SchemaParseError,
  isSchemaNode,
} from '@jasw/pro-cell-shared';
import { defaultRegistry } from './registry';
import { DependencyTracker } from '@jasw/pro-cell-core';
import type {
  AsyncOptions,
  FieldState,
  FormApi,
  FormListener,
  FormOptions,
  FormStateSnapshot,
  FormValidationResult,
  SubmitResult,
  Unsubscribe,
  ValidationResult,
} from './types';

/**
 * React 无关的表单运行时实现。
 *
 * createForm 在一次调用中组装三个独立层：
 * 1. vanilla Zustand 保存 values/fields 快照；
 * 2. DependencyTracker 维护 reactions 和级联事务；
 * 3. 每字段/提交 AbortController 管理异步任务生命周期。
 * 这种分层让 Renderer 只订阅快照，命令式消费者也能复用完全相同的状态语义。
 */

interface MutableFieldState {
  /** 当前值及 UI/校验生命周期状态。 */
  value: unknown;
  error: string | undefined;
  errors: string[];
  visible: boolean;
  disabled: boolean;
  validating: boolean;
  touched: boolean;
}

interface StoreState {
  /** 扁平字段路径到值的映射。 */
  values: Record<string, unknown>;
  /** 扁平字段路径到可变内部字段状态的映射。 */
  fields: Record<string, MutableFieldState>;
  /** 每次可观察更新递增，用作快照缓存键。 */
  version: number;
  /** 仅在表单值发生变化时递增；用于异步校验的世代校验，避免 TOCTOU。 */
  valueVersion: number;
}

interface FieldDefinition {
  /** 该字段按声明顺序执行的规则。 */
  readonly rules: readonly ValidationRuleConfig[];
}

/** 运行时对象判定；表单公开边界拒绝数组和 null。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 从未知异常提取稳定文案，不把任意对象直接拼进 UI。 */
function errorMessage(value: unknown, fallback: string): string {
  try {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value instanceof Error && value.message.length > 0) return value.message;
    if (isRecord(value) && typeof value.message === 'string') return value.message;
    return fallback;
  } catch {
    // 错误对象也可能带有会抛错的 getter；格式化失败时使用统一文案。
    return fallback;
  }
}

/** 使用 own-property 读取，避免特殊字段名触发原型链。 */
function hasOwn<T>(record: Readonly<Record<string, T>>, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, path);
}

/** 读取自有字段；不存在时返回 undefined。 */
function readOwn<T>(record: Readonly<Record<string, T>>, path: string): T | undefined {
  return hasOwn(record, path) ? record[path] : undefined;
}

/** 以数据属性方式写入字段，规避 `__proto__` 的 setter 语义。 */
function writeOwn<T>(record: Record<string, T>, path: string, value: T): void {
  Object.defineProperty(record, path, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

/**
 * 复制表单值快照并保留特殊键的字面语义。
 * 校验器和提交回调只能看到该副本，不能通过顶层属性写入 Zustand 内部状态；
 * 值本身不做深拷贝，以便 File、ReactElement 等运行时对象保持原引用。
 * 时间复杂度 O(F)，F 为快照中的字段数。
 */
function copyValues(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) writeOwn(copy, path, value);
  return copy;
}

/**
 * 读取 createForm 的初始值并复制为安全的扁平记录。
 * 初始值是公开边界，不能假设运行时仍符合 TypeScript 声明；数组、null 或读取
 * getter/proxy 失败都会转换成 FormSubmitError，避免实例创建阶段泄漏原生异常。
 * 时间复杂度 O(F)，F 为初始字段数。
 */
function normalizeInitialValues(
  values: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (values === undefined) return {};
  if (!isRecord(values) || Array.isArray(values)) {
    throw new FormSubmitError('初始值必须是对象');
  }
  try {
    return copyValues(values);
  } catch (cause: unknown) {
    throw new FormSubmitError('读取初始值失败', cause);
  }
}

/** 创建表单命令式 API 的统一错误类型。 */
function makeError(message: string): ProCellError {
  return new FormSubmitError(message);
}

/** 深度优先遍历 Schema，顺序与渲染 children 一致；复杂度 O(N)。 */
function walkSchema(node: SchemaNode, visitor: (node: SchemaNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) walkSchema(child, visitor);
}

/**
 * 将 FormOptions 中的 Schema 解析为隔离、冻结的节点树。
 * 规范化在 createForm 阶段一次完成，后续校验和 tracker 注册共享同一份 AST，
 * 因此调用方之后修改原始对象不会改变表单定义。
 */
function parseSchema(input: SchemaNode | string | undefined): SchemaNode | undefined {
  if (input === undefined) return undefined;
  try {
    const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isSchemaNode(parsed)) {
      throw new SchemaParseError('表单 Schema 根节点无效');
    }
    // 复制表单定义，避免调用方后续修改 Schema；读取失败由 SchemaParseError 承接。
    return normalizeSchemaNode(parsed);
  } catch (cause: unknown) {
    if (cause instanceof SchemaParseError) throw cause;
    throw new SchemaParseError('表单 Schema JSON 无法解析', cause);
  }
}

/** 创建字段初始状态；隐藏/禁用默认值分别为 true/false。 */
function defaultFieldState(value: unknown): MutableFieldState {
  return {
    value,
    error: undefined,
    errors: [],
    visible: true,
    disabled: false,
    validating: false,
    touched: false,
  };
}

/**
 * 将内部可变状态复制成公开只读快照。
 * values/fields 只做一层复制，errors 数组逐字段复制；时间复杂度 O(F)，F 为字段数。
 */
function snapshotOf(state: StoreState): FormStateSnapshot {
  const fields: Record<string, FieldState> = {};
  for (const [path, field] of Object.entries(state.fields)) {
    writeOwn(fields, path, {
      value: field.value,
      error: field.error,
      errors: [...field.errors],
      visible: field.visible,
      disabled: field.disabled,
      validating: field.validating,
      touched: field.touched,
    });
  }
  return { values: copyValues(state.values), fields, version: state.version };
}

/**
 * 将外部 AbortSignal 链接到一次内部任务，并返回清理监听器的函数。
 * 已取消 signal 会立即传播 reason；任务结束必须调用返回的 unlink，避免监听器泄漏。
 */
function linkAbortSignals(controller: AbortController, external?: AbortSignal): Unsubscribe {
  if (external === undefined) return () => undefined;
  if (external.aborted) {
    controller.abort(external.reason);
    return () => undefined;
  }
  const onAbort = (): void => controller.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

interface AbortRaceValue<T> {
  readonly kind: 'value';
  readonly value: T;
}

interface AbortRaceCancelled {
  readonly kind: 'aborted';
}

type AbortRaceOutcome<T> = AbortRaceValue<T> | AbortRaceCancelled;

/**
 * 让一个惰性异步操作与 AbortSignal 竞速。
 *
 * 第三方提交回调可能忽略 signal，甚至返回永不结束的 Promise；仅在 await
 * 之后检查 signal 会使 FormApi 永远挂起。这里在 Promise 层竞速并在结束时移除
 * 监听器，因此取消可以及时返回 `AbortError`，而不会遗留监听器。
 * 时间复杂度 O(1)，不会尝试强行终止底层 Promise（调用方仍应在回调中传递 signal）。
 */
async function awaitWithAbort<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new AbortError('操作已取消', signal.reason);

  let removeAbortListener: (() => void) | undefined;
  let resolveAbort: (() => void) | undefined;
  const abortPromise = new Promise<AbortRaceCancelled>((resolve) => {
    resolveAbort = () => resolve({ kind: 'aborted' });
  });
  const onAbort = (): void => resolveAbort?.();
  signal.addEventListener('abort', onAbort, { once: true });
  removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  // signal 可能在注册监听器与下一行之间触发，必须再次检查避免漏取消。
  if (signal.aborted) onAbort();

  const operationPromise: Promise<AbortRaceValue<T>> = Promise.resolve()
    .then(() => {
      // 若 abort 在微任务调度前发生，不再启动用户回调。
      if (signal.aborted) throw new AbortError('操作已取消', signal.reason);
      return operation();
    })
    .then((value) => ({ kind: 'value', value }));

  try {
    const outcome: AbortRaceOutcome<T> = await Promise.race([operationPromise, abortPromise]);
    if (outcome.kind === 'aborted') {
      throw new AbortError('操作已取消', signal.reason);
    }
    return outcome.value;
  } finally {
    removeAbortListener?.();
    removeAbortListener = undefined;
  }
}

/** 使用 Object.is 判断字段是否真正变化，避免无意义通知和渲染。 */
function changedField(state: StoreState, path: string, value: unknown): boolean {
  const current = readOwn(state.values, path);
  return !Object.is(current, value);
}

/**
 * 创建独立的 vanilla Zustand 表单实例。
 *
 * 初始化阶段依次完成 Schema 规范化、字段定义收集、DependencyTracker 建图和初始
 * reaction 求值；结构错误会在实例返回前抛出领域错误。运行时单字段更新为
 * O(1)，reaction 级联由 DependencyTracker 按受影响字段数执行；异步校验不会阻塞写值。
 */
export function createForm<TSubmit = unknown>(
  options: FormOptions<TSubmit> = {},
): FormApi<TSubmit> {
  // 先把 Schema 变成不可变定义，再从同一份定义收集 rules/reactions，保证解析器、
  // tracker 与表单状态不会分别看到不同版本的节点。
  const schema = parseSchema(options.schema);
  const definitions = new Map<string, FieldDefinition>();
  const initialValues = normalizeInitialValues(options.initialValues);
  const fields: Record<string, MutableFieldState> = {};
  if (schema !== undefined) {
    // 字段定义使用扁平 name；没有 name 的纯布局节点不会占用表单状态空间。
    walkSchema(schema, (node) => {
      if (
        ((node.rules?.length ?? 0) > 0 || (node.reactions?.length ?? 0) > 0) &&
        (node.name === undefined || node.name.trim().length === 0)
      ) {
        throw new SchemaParseError('包含 rules 或 reactions 的字段必须提供稳定 name');
      }
      if (node.name !== undefined && node.name.trim().length === 0) {
        throw new SchemaParseError('Schema 字段 name 不能为空');
      }
      if (node.name === undefined) return;
      if (node.rules !== undefined) definitions.set(node.name, { rules: node.rules });
      if (!hasOwn(initialValues, node.name)) writeOwn(initialValues, node.name, undefined);
      writeOwn(fields, node.name, defaultFieldState(readOwn(initialValues, node.name)));
    });
  }
  for (const [path, value] of Object.entries(initialValues)) {
    // initialValues 中额外字段也可被命令式 API 管理，即使它们不在 Schema 中。
    if (!hasOwn(fields, path)) writeOwn(fields, path, defaultFieldState(value));
  }

  const store = createStore<StoreState>(() => ({
    values: copyValues(initialValues),
    fields,
    version: 0,
    valueVersion: 0,
  }));
  const listeners = new Set<FormListener>();
  let listenerFailure: ReactionExecutionError | undefined;
  const validators = options.validators ?? {};
  const activeControllers = new Map<string, AbortController>();
  let submitController: AbortController | undefined;
  let disposed = false;
  // setValues 会先提交整批请求值，再逐个通知 tracker；若较早的 reaction 已经
  // 改写了批次中的后续字段，这个临时集合让后续循环跳过重复通知。使用可恢复的
  // 引用而不是全局布尔值，兼容 reaction/订阅者在批处理期间重入 setValues。
  let activeBatchReactionWrites: Set<string> | undefined;
  const registry = options.registry ?? defaultRegistry;

  const adapter: {
    readonly setVisible: (path: string, value: boolean) => Result<void, ProCellError>;
    readonly setDisabled: (path: string, value: boolean) => Result<void, ProCellError>;
    readonly setValue: (path: string, value: unknown) => Result<void, ProCellError>;
  } = {
    // Tracker 通过这些适配器写 Zustand，避免核心包依赖 React/Zustand；每个适配器只
    // 提交一个不可变 state patch，再消费订阅者可能产生的错误。
    setVisible: (path: string, value: boolean): Result<void, ProCellError> => {
      const current =
        readOwn(store.getState().fields, path) ??
        defaultFieldState(readOwn(store.getState().values, path));
      if (current.visible === value) return ok(undefined);
      store.setState((state) => ({
        fields: { ...state.fields, [path]: { ...current, visible: value } },
        version: state.version + 1,
      }));
      return consumeListenerFailure();
    },
    setDisabled: (path: string, value: boolean): Result<void, ProCellError> => {
      const current =
        readOwn(store.getState().fields, path) ??
        defaultFieldState(readOwn(store.getState().values, path));
      if (current.disabled === value) return ok(undefined);
      store.setState((state) => ({
        fields: { ...state.fields, [path]: { ...current, disabled: value } },
        version: state.version + 1,
      }));
      return consumeListenerFailure();
    },
    setValue: (path: string, value: unknown): Result<void, ProCellError> => {
      if (!changedField(store.getState(), path, value)) return ok(undefined);
      // reaction 驱动的写入同样是值变化：先取消旧异步校验，再把新值暴露给消费者。
      activeControllers.get(path)?.abort();
      store.setState((state) => {
        const previous =
          readOwn(state.fields, path) ?? defaultFieldState(readOwn(state.values, path));
        return {
          values: { ...state.values, [path]: value },
          fields: {
            ...state.fields,
            // reaction 写入属于程序行为；保留用户原有 touched 状态，避免初始化联动
            // 被误记为用户交互。
            [path]: { ...previous, value },
          },
          version: state.version + 1,
          valueVersion: state.valueVersion + 1,
        };
      });
      activeBatchReactionWrites?.add(path);
      return consumeListenerFailure();
    },
  };
  const tracker = new DependencyTracker({
    getValue: (path: string) => readOwn(store.getState().values, path),
    setVisible: adapter.setVisible,
    setDisabled: adapter.setDisabled,
    setValue: adapter.setValue,
    maxTransactionDepth: options.maxReactionDepth ?? 100,
  });
  if (schema !== undefined) {
    // 建图必须发生在任何用户 setValue 前；一旦出现循环，createForm 直接失败，
    // 不返回一个可能只注册了部分联动的半初始化实例。
    const registered = tracker.registerSchema(schema);
    if (!registered.ok) throw registered.error;
  }

  /** 将 Zustand 变更广播给高层订阅者；单个 listener 异常不会阻断其它 listener。 */
  const emit = (): void => {
    if (disposed) return;
    const current = snapshotOf(store.getState());
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (cause: unknown) {
        listenerFailure ??= new ReactionExecutionError('表单订阅者执行失败', undefined, cause);
      }
    }
  };
  /** 读取并清空最近一次订阅异常，作为当前命令的 Result 错误返回。 */
  const consumeListenerFailure = (): Result<void, ProCellError> => {
    const failure = listenerFailure;
    listenerFailure = undefined;
    return failure === undefined ? ok(undefined) : err(failure);
  };
  const stopStoreListener = store.subscribe(() => emit());

  let cachedSnapshot = snapshotOf(store.getState());
  let cachedSnapshotVersion = cachedSnapshot.version;

  /** 返回字段状态副本，防止调用方直接修改 store 内部数组或对象。 */
  const getFieldState = (path: string): FieldState => {
    const state = store.getState();
    const field = readOwn(state.fields, path) ?? defaultFieldState(readOwn(state.values, path));
    return {
      value: field.value,
      error: field.error,
      errors: [...field.errors],
      visible: field.visible,
      disabled: field.disabled,
      validating: field.validating,
      touched: field.touched,
    };
  };

  /**
   * 设置单个字段值并触发依赖级联。
   * 先提交用户值、再 notify tracker；tracker 产生的 reaction 写入会继续进入串行队列，
   * 并且每次写值都会取消该字段旧的异步校验。
   */
  const setValue = (path: string, value: unknown): Result<void, ProCellError> => {
    if (disposed) return err(makeError('表单实例已销毁'));
    const state = store.getState();
    if (!changedField(state, path, value)) return ok(undefined);
    activeControllers.get(path)?.abort();
    const previous = readOwn(state.fields, path) ?? defaultFieldState(readOwn(state.values, path));
    store.setState({
      values: { ...state.values, [path]: value },
      fields: { ...state.fields, [path]: { ...previous, value, touched: true } },
      version: state.version + 1,
      valueVersion: state.valueVersion + 1,
    });
    const emitted = consumeListenerFailure();
    // Zustand 的订阅回调是同步执行的；用户可能在上面的 store.setState
    // 触发的回调中再次 setValue（甚至由其它 reaction 间接改写当前字段）。
    // 此时当前值已经不是本次调用请求的 value，外层再把过期 previous -> value
    // 通知 tracker 会覆盖内层通知维护的依赖快照。只要检测到值被重入改写，
    // 就跳过这条过期通知；内层 setValue 已经负责发出真实变化事件。
    if (!Object.is(readOwn(store.getState().values, path), value)) {
      return emitted.ok ? ok(undefined) : emitted;
    }
    const notified = tracker.notify(path, readOwn(state.values, path), value, 'form.setValue');
    if (!notified.ok) return err(notified.error);
    if (!emitted.ok) return emitted;
    return ok(undefined);
  };

  /**
   * 批量设置字段值。
   * 先一次性提交基础 patch，再按调用方枚举顺序通知 tracker；若前一个字段的 reaction
   * 已覆盖后一个请求值，则跳过过期通知，维持 store 与 tracker 的最终值一致。
   */
  const setValues = (values: Readonly<Record<string, unknown>>): Result<void, ProCellError> => {
    if (disposed) return err(makeError('表单实例已销毁'));
    if (!isRecord(values) || Array.isArray(values)) {
      return err(new FormSubmitError('批量设置的表单值必须是对象'));
    }
    try {
      const state = store.getState();
      const nextValues = { ...state.values };
      const nextFields = { ...state.fields };
      const previousValues = new Map<string, unknown>();
      const changed: string[] = [];
      for (const [path, value] of Object.entries(values)) {
        if (!Object.is(readOwn(nextValues, path), value)) {
          activeControllers.get(path)?.abort();
          previousValues.set(path, readOwn(nextValues, path));
          writeOwn(nextValues, path, value);
          const field = readOwn(nextFields, path) ?? defaultFieldState(readOwn(state.values, path));
          writeOwn(nextFields, path, { ...field, value, touched: true });
          changed.push(path);
        }
      }
      if (changed.length === 0) return ok(undefined);
      store.setState({
        values: nextValues,
        fields: nextFields,
        version: state.version + 1,
        valueVersion: state.valueVersion + 1,
      });
      const emitted = consumeListenerFailure();
      const previousBatchWrites = activeBatchReactionWrites;
      const batchWrites = new Set<string>();
      activeBatchReactionWrites = batchWrites;
      try {
        for (const path of changed) {
          // 同一批中较早字段可能触发 reaction 并有意覆盖当前路径。此时 tracker
          // 已收到 reaction 的通知；不能再回放过期批量值，否则 Zustand store 与依赖快照会分叉。
          // 即使 reaction 恰好把字段写回请求值，也必须跳过手工通知，避免下游 reaction
          // 被重复执行；只有 adapter 的真实值变化才会加入 batchWrites。
          if (batchWrites.has(path)) continue;
          const current = readOwn(store.getState().values, path);
          const requested = readOwn(nextValues, path);
          if (!Object.is(current, requested)) {
            continue;
          }
          const previous = previousValues.get(path);
          if (Object.is(previous, requested)) {
            continue;
          }
          const notified = tracker.notify(path, previous, requested, 'form.setValues');
          if (!notified.ok) return err(notified.error);
        }
      } finally {
        activeBatchReactionWrites = previousBatchWrites;
      }
      if (!emitted.ok) return emitted;
      return ok(undefined);
    } catch (cause: unknown) {
      return err(new FormSubmitError('批量设置表单值失败', cause));
    }
  };

  /** 公开可见性写入，委托同一 adapter 以保持 reaction/命令式语义一致。 */
  const setVisible = (path: string, visible: boolean): Result<void, ProCellError> => {
    if (disposed) return err(makeError('表单实例已销毁'));
    return adapter.setVisible(path, visible);
  };

  /** 公开禁用状态写入；只改变渲染属性，不触碰字段值。 */
  const setDisabled = (path: string, disabled: boolean): Result<void, ProCellError> => {
    if (disposed) return err(makeError('表单实例已销毁'));
    return adapter.setDisabled(path, disabled);
  };

  /**
   * 校验一个字段，并维护 validating/errors 生命周期。
   * 同字段新调用会先 abort 旧 controller；finally 仅允许当前 controller 写回状态，
   * 因此慢速远程响应不会覆盖较新的结果。取消返回 cancelled 且清空普通错误。
   */
  const validateField = async (
    path: string,
    asyncOptions: AsyncOptions = {},
  ): Promise<ValidationResult> => {
    // 每个字段只有一个“当前”校验控制器；Map 中的引用即为过期结果判定依据。
    const previousController = activeControllers.get(path);
    previousController?.abort();
    // 即使新调用携带已取消的 signal，也要先取消旧运行；否则旧任务会继续执行并可能
    // 写回过期结果。旧任务的 finally 会负责清理 validating 状态。
    if (disposed || asyncOptions.signal?.aborted) {
      return { valid: false, field: path, errors: [], cancelled: true };
    }
    const controller = new AbortController();
    activeControllers.set(path, controller);
    const unlink = linkAbortSignals(controller, asyncOptions.signal);
    // 自定义校验器可以读取整份 values，而不只读取当前字段。只监听当前 path 会让
    // “确认密码”这类跨字段校验在依赖值变化后写回旧结果，因此以 valueVersion 作为
    // 本次上下文的世代标识；任意字段值变化都取消这次运行。
    const startValueVersion = store.getState().valueVersion;
    const stopValueWatch = store.subscribe(() => {
      if (!controller.signal.aborted && store.getState().valueVersion !== startValueVersion) {
        controller.abort(new AbortError('表单值在字段校验期间发生变化'));
      }
    });
    const field =
      readOwn(store.getState().fields, path) ??
      defaultFieldState(readOwn(store.getState().values, path));
    store.setState((state) => ({
      fields: {
        ...state.fields,
        [path]: { ...field, validating: true, errors: [], error: undefined },
      },
      version: state.version + 1,
    }));
    // 校验状态更新属于内部生命周期事件；订阅者异常不能污染后续公开操作。
    consumeListenerFailure();
    // 固定本次运行的值快照；值世代变化会取消 controller，旧结果不会写回。
    const value = readOwn(store.getState().values, path);
    const definition = definitions.get(path);
    let errors: string[] = [];
    try {
      const validation = await validateValue(value, definition?.rules ?? [], {
        field: path,
        // 传递快照而不是 Zustand 内部对象；校验器即使误写顶层属性也不会污染表单。
        values: copyValues(store.getState().values),
        validators,
        signal: controller.signal,
      });
      if (validation.cancelled || controller.signal.aborted) {
        return { valid: false, field: path, errors: [], cancelled: true };
      }
      errors = validation.errors.map((error) => error.message);
    } catch (cause: unknown) {
      if (controller.signal.aborted) {
        return { valid: false, field: path, errors: [], cancelled: true };
      }
      errors = [errorMessage(cause, '字段校验执行失败')];
    } finally {
      // 无论成功、失败还是取消，都解绑外部 signal，并只由最新 controller 清理 UI 状态。
      stopValueWatch();
      unlink();
      const isLatest = activeControllers.get(path) === controller;
      if (isLatest) activeControllers.delete(path);
      if (isLatest) {
        const latest = readOwn(store.getState().fields, path) ?? defaultFieldState(value);
        store.setState((state) => ({
          fields: {
            ...state.fields,
            [path]: {
              ...latest,
              validating: false,
              errors: controller.signal.aborted ? [] : [...errors],
              error: controller.signal.aborted ? undefined : errors[0],
            },
          },
          version: state.version + 1,
        }));
        consumeListenerFailure();
      }
    }
    return { valid: errors.length === 0, field: path, errors: [...errors] };
  };

  /**
   * 并行校验所有已知字段并聚合错误。
   * Promise.all 保持路径数组顺序；校验开始后若表单值世代发生变化，会中止本次聚合，
   * 防止把旧值的结果与新值混合（TOCTOU）。任一字段取消都会让表单 valid=false，但不会
   * 把取消当作 errors 文案。复杂度 O(F + ΣR)，异步耗时取决于最慢校验器。
   */
  const validate = async (asyncOptions: AsyncOptions = {}): Promise<FormValidationResult> => {
    if (disposed || asyncOptions.signal?.aborted) {
      return { valid: false, errors: {}, fields: {}, cancelled: true };
    }
    const startState = store.getState();
    const startValueVersion = startState.valueVersion;
    const paths = [...new Set([...definitions.keys(), ...Object.keys(startState.values)])];
    // validateField 为每个字段创建独立 controller；此 controller 负责在任意字段值
    // 变化时一次性取消整批任务，避免某个忽略 signal 的远程校验拖住过期聚合。
    const validationController = new AbortController();
    const unlinkExternal = linkAbortSignals(validationController, asyncOptions.signal);
    const stopValueWatch = store.subscribe(() => {
      const current = store.getState();
      if (
        !validationController.signal.aborted &&
        (disposed || current.valueVersion !== startValueVersion)
      ) {
        validationController.abort(new AbortError('表单值在校验期间发生变化'));
      }
    });
    try {
      const results = await Promise.all(
        paths.map((path) => validateField(path, { signal: validationController.signal })),
      );
      const errors: Record<string, readonly string[]> = {};
      const fieldsResult: Record<string, ValidationResult> = {};
      let valid = true;
      let cancelled = validationController.signal.aborted;
      for (const result of results) {
        writeOwn(fieldsResult, result.field, result);
        if (result.errors.length > 0) {
          valid = false;
          writeOwn(errors, result.field, result.errors);
        }
        if (result.cancelled) {
          cancelled = true;
          valid = false;
        }
      }
      // 即使所有字段 Promise 恰好在变更前完成，也要在返回前再次检查世代；否则
      // 调用方可能拿到“校验通过”但对应另一份 values 的结果。
      const stale =
        disposed ||
        store.getState().valueVersion !== startValueVersion ||
        validationController.signal.aborted;
      if (stale) {
        return { valid: false, errors: {}, fields: fieldsResult, cancelled: true };
      }
      return { valid, errors, fields: fieldsResult, ...(cancelled ? { cancelled: true } : {}) };
    } finally {
      stopValueWatch();
      unlinkExternal();
    }
  };

  /**
   * 执行“取消旧提交 -> 全量校验 -> 调用 onSubmit”的事务流程。
   * 提交拥有独立 controller，并把 signal 传给用户回调；新提交、reset 或 dispose 会
   * 终止旧任务。校验失败不会调用 onSubmit，回调异常会封装为 FormSubmitError。
   */
  const submit = async (asyncOptions: AsyncOptions = {}): Promise<SubmitResult<TSubmit>> => {
    if (disposed) {
      return {
        ok: false,
        submitted: false,
        error: makeError('表单实例已销毁'),
        validation: { valid: false, errors: {}, fields: {}, cancelled: true },
      };
    }
    // 提交采用 latest-wins 策略；旧提交的 onSubmit 若仍在等待，返回值会被取消分支丢弃。
    submitController?.abort();
    const controller = new AbortController();
    submitController = controller;
    const unlink = linkAbortSignals(controller, asyncOptions.signal);
    try {
      // 记录本次提交校验所对应的值世代。validate 会在自身内部监听世代变化，
      // 这里再做一次提交边界检查，覆盖“校验完成后、回调启动前”的最后竞态窗口。
      const validationValueVersion = store.getState().valueVersion;
      let validation: FormValidationResult;
      try {
        validation = await validate({ signal: controller.signal });
      } catch (cause: unknown) {
        // 即使校验层出现未预期异常，提交结果仍保持完整的判别结构；调用方可以
        // 安全地读取 validation，而不必为一个缺失字段再写一层 null 检查。
        return {
          ok: false,
          submitted: false,
          error: new FormSubmitError(errorMessage(cause, '表单校验执行失败'), cause),
          validation: { valid: false, errors: {}, fields: {} },
        };
      }
      if (
        disposed ||
        validation.cancelled ||
        controller.signal.aborted ||
        store.getState().valueVersion !== validationValueVersion
      ) {
        return { ok: false, submitted: false, error: new AbortError('提交已取消'), validation };
      }
      if (!validation.valid)
        return {
          ok: false,
          submitted: false,
          error: new FormSubmitError('表单校验失败'),
          validation,
        };
      if (options.onSubmit === undefined) {
        return {
          ok: true,
          submitted: true,
          value: copyValues(store.getState().values) as TSubmit,
          validation,
        };
      }
      const onSubmit = options.onSubmit;
      const submitValues = copyValues(store.getState().values);
      const submitValueVersion = store.getState().valueVersion;
      // 复制 values 与读取世代之间若发生同步更新，也不能把不一致快照交给回调。
      if (submitValueVersion !== validationValueVersion) {
        return {
          ok: false,
          submitted: false,
          error: new AbortError('提交已取消'),
          validation,
        };
      }
      try {
        const value = await awaitWithAbort(
          () =>
            onSubmit(submitValues, {
              signal: controller.signal,
              form: api,
            }),
          controller.signal,
        );
        // 回调可能在等待期间触发了 setValue；此时它处理的是旧快照，不能报告提交成功。
        if (
          controller.signal.aborted ||
          disposed ||
          store.getState().valueVersion !== submitValueVersion
        )
          return {
            ok: false,
            submitted: false,
            error: new AbortError('提交已取消'),
            validation,
          };
        return { ok: true, submitted: true, value, validation };
      } catch (cause: unknown) {
        if (controller.signal.aborted || cause instanceof AbortError) {
          return {
            ok: false,
            submitted: false,
            error: new AbortError('提交已取消'),
            validation,
          };
        }
        return {
          ok: false,
          submitted: false,
          error: new FormSubmitError(errorMessage(cause, '表单提交失败'), cause),
          validation,
        };
      }
    } finally {
      unlink();
      if (submitController === controller) submitController = undefined;
    }
  };

  /**
   * 重置值、校验状态和触碰状态，并重新执行初始 reactions。
   * reset 是一个新的状态世代：所有字段校验和提交任务先取消，tracker 以新值重新初始化，
   * 防止旧字段残留继续参与依赖求值。
   */
  const reset = (
    values: Readonly<Record<string, unknown>> = initialValues,
  ): Result<void, ProCellError> => {
    if (disposed) return err(makeError('表单实例已销毁'));
    if (!isRecord(values) || Array.isArray(values)) {
      return err(new FormSubmitError('重置值必须是对象'));
    }
    try {
      // 先完整读取并构造新快照。入参可能是 getter/proxy；如果读取失败，
      // reset 应返回 Err，而不能先取消旧校验并把字段永久留在 validating 状态。
      const previousValues = store.getState().values;
      const nextValues = copyValues(values);
      const nextFields: Record<string, MutableFieldState> = {};
      for (const [path, value] of Object.entries(nextValues))
        writeOwn(nextFields, path, defaultFieldState(value));
      for (const path of definitions.keys()) {
        if (!hasOwn(nextValues, path)) {
          writeOwn(nextValues, path, undefined);
          writeOwn(nextFields, path, defaultFieldState(undefined));
        }
      }
      // 新快照已可用后再进入不可逆的生命周期切换，使旧异步结果全部失效。
      for (const controller of activeControllers.values()) controller.abort();
      activeControllers.clear();
      submitController?.abort();
      store.setState((state) => ({
        values: nextValues,
        fields: nextFields,
        version: state.version + 1,
        valueVersion: state.valueVersion + 1,
      }));
      const emitted = consumeListenerFailure();
      // 清空 tracker 中已被 reset 移除的字段，避免旧值继续参与 reaction 求值。
      const trackerValues: Record<string, unknown> = {};
      for (const path of new Set([...Object.keys(previousValues), ...Object.keys(nextValues)])) {
        writeOwn(trackerValues, path, readOwn(nextValues, path));
      }
      const initialized = tracker.initialize(trackerValues);
      if (!initialized.ok) return err(initialized.error);
      if (!emitted.ok) return emitted;
      return ok(undefined);
    } catch (cause: unknown) {
      return err(new FormSubmitError('重置表单失败', cause));
    }
  };

  /** 注册高层快照监听器；Set 保证同一函数重复注册只调用一次。 */
  const subscribe = (listener: FormListener): Unsubscribe => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /**
   * 获取 React/外部消费者使用的稳定快照。
   * 只有 version 变化才重新复制，保证 useSyncExternalStore 在同一版本返回同一引用。
   */
  const getSnapshot = (): FormStateSnapshot => {
    const state = store.getState();
    if (state.version !== cachedSnapshotVersion) {
      cachedSnapshot = snapshotOf(state);
      cachedSnapshotVersion = state.version;
    }
    return cachedSnapshot;
  };
  // 将闭包函数组装为公开 API；内部 store/tracker/controller 均不暴露，
  // store、tracker 和 controller 均留在闭包内，公开 API 只暴露状态快照与 Result。
  const api: FormApi<TSubmit> = {
    getValue: (path) => readOwn(store.getState().values, path),
    getValues: () => ({ ...store.getState().values }),
    setValue,
    setValues,
    setVisible,
    setDisabled,
    getFieldState,
    validateField,
    validate,
    submit,
    reset,
    subscribe,
    subscribeSnapshot: (listener) =>
      store.subscribe(() => {
        try {
          listener();
        } catch (cause: unknown) {
          // useSyncExternalStore 使用这个订阅边界。外部监听器即使异常，
          // 也不应让 Zustand 的 setState 直接抛出并跳过公开 API 的 Result 语义。
          listenerFailure ??= new ReactionExecutionError(
            '表单快照订阅者执行失败',
            undefined,
            cause,
          );
        }
      }),
    getSnapshot,
    getSchema: () => schema,
    getRegistry: () => registry,
    dispose: () => {
      if (disposed) return;
      // dispose 是不可逆的生命周期终点：取消所有异步任务、停止 Zustand 监听，
      // 并把 validating 归零，避免卸载后仍有悬挂回调引用表单状态。
      disposed = true;
      for (const controller of activeControllers.values()) controller.abort();
      activeControllers.clear();
      submitController?.abort();
      submitController = undefined;
      store.setState((state) => ({
        fields: Object.fromEntries(
          Object.entries(state.fields).map(([path, field]) => [
            path,
            field.validating ? { ...field, validating: false } : field,
          ]),
        ),
        version: state.version + 1,
      }));
      tracker.dispose();
      stopStoreListener();
      listeners.clear();
    },
  };

  // 初始化 reaction 必须在 api 闭包建立后执行，保证 setValue 回调可用；
  // 初始化失败直接抛出领域错误，不返回只完成一部分初始化的表单实例。
  const initialized = tracker.initialize(initialValues);
  if (!initialized.ok) throw initialized.error;
  return api;
}

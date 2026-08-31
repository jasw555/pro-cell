/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  createElement,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type * as React from 'react';
import { Form } from 'antd';
import type { FormItemProps } from 'antd';
import { normalizeSchemaNode, type SchemaNode } from '@jasw/pro-cell-shared';
import {
  ComponentNotFoundError,
  ProCellError,
  ReactionExecutionError,
  SchemaParseError,
  isSchemaNode,
} from '@jasw/pro-cell-shared';
import { createForm } from './formStore';
import {
  defaultRegistry,
  getRegisteredComponent,
  registerComponent,
  type ReactComponentRegistry,
} from './registry';
import { getBuiltinComponent } from './builtins';
import type {
  ComponentRegistryLike,
  FieldState,
  FormApi,
  FormOptions,
  SchemaFormProps,
  SchemaRendererProps,
  Unsubscribe,
} from './types';

/**
 * React 19 渲染层。
 *
 * 渲染流程分为“解析静态 Schema -> 读取 FormApi 快照 -> 注入值/事件 -> 创建 antd
 * Form.Item”四步。useSyncExternalStore 负责并发渲染下的一致快照，真正的状态和联动
 * 逻辑留在 vanilla FormApi，便于脱离 React 测试或在 SSR 中复用。
 */
export const FormContext = createContext<FormApi | null>(null);

/**
 * 解析并规范化渲染入口的 Schema。
 * 这里额外检查稳定字段名，确保 rules/reactions 能够与 FormApi 建立确定映射；
 * JSON 解析、代理对象读取或规范化失败时返回 undefined，由渲染入口抛出 SchemaParseError。
 */
function parseSchema(input: SchemaNode | string): SchemaNode | undefined {
  try {
    const parsed: unknown = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
    if (!isSchemaNode(parsed) || !hasStableFieldNames(parsed)) return undefined;
    // 与 SchemaParser 的边界保持一致：复制并冻结静态 AST，防止调用方在两次
    // render 之间修改 props 或 children。
    return normalizeSchemaNode(parsed);
  } catch {
    // 运行时输入可能带有会抛错的 getter/Proxy，与格式错误一样按无效 Schema 处理。
    return undefined;
  }
}

/** 判断值是否能安全作为 antd Form.Item label 渲染。 */
function isRenderableLabel(value: unknown): value is React.ReactNode {
  if (value === null || typeof value === 'string' || typeof value === 'number') return true;
  if (typeof value === 'boolean' || isValidElement(value)) return true;
  return Array.isArray(value) && value.every(isRenderableLabel);
}

/** 递归确认所有带规则/联动的节点具有非空稳定 name。复杂度 O(N)。 */
function hasStableFieldNames(node: SchemaNode): boolean {
  if (node.name !== undefined && node.name.trim().length === 0) {
    return false;
  }
  if (
    ((node.rules?.length ?? 0) > 0 || (node.reactions?.length ?? 0) > 0) &&
    (node.name === undefined || node.name.trim().length === 0)
  ) {
    return false;
  }
  return (node.children ?? []).every(hasStableFieldNames);
}

/** 比较错误数组内容，避免 getFieldState 返回的新数组破坏快照引用稳定性。 */
function sameErrors(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * 判断字段渲染所依赖的状态是否发生变化。
 * value 使用 Object.is，能正确区分 NaN 与 -0；其余标志和错误按值比较。
 */
function sameFieldState(left: FieldState, right: FieldState): boolean {
  return (
    Object.is(left.value, right.value) &&
    left.error === right.error &&
    sameErrors(left.errors, right.errors) &&
    left.visible === right.visible &&
    left.disabled === right.disabled &&
    left.validating === right.validating &&
    left.touched === right.touched
  );
}

interface FieldSnapshotStore {
  readonly subscribe: (listener: () => void) => Unsubscribe;
  readonly getSnapshot: () => FieldState;
}

/**
 * 为单个字段创建带选择器的外部快照。
 *
 * FormApi 的底层通知仍可覆盖整张表单，但这里只在目标字段的可渲染状态真正变化时
 * 通知 React。缓存最近一次等价快照，满足 useSyncExternalStore 对引用稳定性的要求，
 * 因而修改 fieldB 不会连带重渲染 fieldA。
 */
function createFieldSnapshotStore(form: FormApi, fieldName: string): FieldSnapshotStore {
  let snapshot = form.getFieldState(fieldName);
  const getSnapshot = (): FieldState => {
    const next = form.getFieldState(fieldName);
    if (!sameFieldState(snapshot, next)) snapshot = next;
    return snapshot;
  };
  const subscribe = (listener: () => void): Unsubscribe => {
    const checkForUpdates = (): void => {
      const previous = snapshot;
      const next = getSnapshot();
      if (next !== previous) listener();
    };
    const nativeSubscribe = form.subscribeSnapshot;
    return nativeSubscribe === undefined
      ? form.subscribe(checkForUpdates)
      : nativeSubscribe.call(form, checkForUpdates);
  };
  return { subscribe, getSnapshot };
}

/** 使用字段级稳定快照接入 React 19 并发渲染与 SSR。 */
function useFieldState(form: FormApi, fieldName: string): FieldState {
  const store = useMemo(() => createFieldSnapshotStore(form, fieldName), [fieldName, form]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** 类型守卫：识别 Schema props 中可调用的用户 onChange。 */
function isFunction(value: unknown): value is (...args: readonly unknown[]) => unknown {
  return typeof value === 'function';
}

interface PendingDisposal {
  readonly form: FormApi;
  readonly cancel: () => void;
}

/**
 * 延迟一个拥有者表单的销毁，并返回可撤销句柄。
 *
 * React 19 StrictMode 会在开发环境中执行“effect cleanup -> effect setup”的重放；
 * 若 cleanup 立即 dispose，重放后的同一个 FormApi 会被误判为已销毁。放到微任务
 * 可让紧随其后的 setup 取消销毁，而真实卸载没有后续 setup，仍会在本轮结束时释放。
 */
function deferDispose(form: FormApi): () => void {
  let cancelled = false;
  const dispose = (): void => {
    if (!cancelled) form.dispose();
  };
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(dispose);
  } else {
    void Promise.resolve().then(dispose);
  }
  return (): void => {
    cancelled = true;
  };
}

/**
 * 管理由当前 React 组件拥有的 FormApi 生命周期。
 * 相同实例的 StrictMode effect 重放会撤销待处理销毁；实例真正替换时，旧实例的
 * 销毁任务不会被新实例取消。外部传入的 form 不属于组件，因此不会被 dispose。
 */
function useOwnedFormDisposal(form: FormApi | null, enabled: boolean): void {
  const pending = useRef<PendingDisposal | undefined>(undefined);
  useEffect(() => {
    const queued = pending.current;
    if (queued !== undefined) {
      if (queued.form === form) queued.cancel();
      pending.current = undefined;
    }
    if (!enabled || form === null) return;
    return () => {
      pending.current = { form, cancel: deferDispose(form) };
    };
  }, [enabled, form]);
}

/** 单个 Schema 节点渲染器的递归参数。 */
interface SchemaNodeRendererProps {
  readonly node: SchemaNode;
  readonly form: FormApi;
  readonly path: string;
  readonly registry: ComponentRegistryLike;
}

interface RenderSchemaNodeOptions extends SchemaNodeRendererProps {
  /** 仅命名字段提供运行时状态；纯布局节点不订阅表单。 */
  readonly field?: FieldState;
}

/**
 * 创建单个 Schema 节点并递归处理 children。
 * 这是一个无 Hook 的纯渲染函数：字段订阅由 FieldSchemaNodeRenderer 负责，布局节点
 * 可直接调用而不接入外部 store，因此不会因任意表单值变化而重复执行。
 */
function renderSchemaNode({
  node,
  form,
  path,
  registry,
  field,
}: RenderSchemaNodeOptions): React.ReactNode {
  const fieldName = node.name;
  if (field !== undefined && !field.visible) return null;

  let entry: ReturnType<typeof getRegisteredComponent>;
  try {
    // 用户注册表优先；缺失时只读回退到内置表，不向注册表写入任何内容。
    entry = getRegisteredComponent(registry, node.$comp) ?? getBuiltinComponent(node.$comp);
  } catch (cause: unknown) {
    throw new ReactionExecutionError(`组件 “${node.$comp}” 注册表读取失败`, path, cause);
  }
  if (entry === undefined) {
    throw new ComponentNotFoundError(node.$comp, path);
  }

  const rawProps = (node.props ?? {}) as Record<string, unknown>;
  const props: Record<string, unknown> = { ...rawProps };
  delete props.children;
  delete props.name;
  delete props.rules;
  delete props.reactions;
  delete props.label;
  if (field !== undefined) {
    // Schema props 只提供静态默认值；字段受控值始终由快照覆盖，避免外部 props
    // 与 Zustand store 同时控制字段。disabled 采用 OR，确保 Schema 显式禁用不会被联动解除。
    if (props.id === undefined) props.id = fieldName;
    props[entry.valueProp] = field.value;
    props.disabled = Boolean(props.disabled) || field.disabled;
    const changeProp = entry.changeProp ?? 'onChange';
    const userOnChange = props[changeProp];
    props[changeProp] = (event: unknown, ...rest: readonly unknown[]): void => {
      try {
        // 先调用用户自己的回调，再提交 FormApi；这样保留 antd/自定义组件原有事件语义，
        // 同时任何异常都会在此边界转换为可识别的 ReactionExecutionError。
        if (isFunction(userOnChange)) userOnChange(event, ...rest);
        const nextValue = entry.eventToValue(event);
        const updated = form.setValue(fieldName as string, nextValue);
        if (!updated.ok) throw updated.error;
      } catch (cause: unknown) {
        if (cause instanceof ProCellError) throw cause;
        throw new ReactionExecutionError(`字段 “${fieldName}” 的事件处理失败`, fieldName, cause);
      }
    };
  }

  // key 使用 name 或递归路径，保证同一 Schema 中兄弟节点的顺序变化不会复用错误状态。
  const children = (node.children ?? []).map((child, index) => {
    const childPath = child.name ?? `${path}.${index}`;
    return createElement(SchemaNodeRenderer, {
      key: `${childPath}.${child.$comp}`,
      node: child,
      form,
      path: childPath,
      registry,
    });
  });
  if (children.length > 0) props.children = children;

  // 先创建组件元素，再包裹 Form.Item；这样 Form.Item 只负责错误/标签展示，
  // 值同步和事件转换仍由上面的 FormApi 闭包控制。
  const element = createElement(entry.component, props);
  if (fieldName === undefined) return element;
  const fieldState = field ?? form.getFieldState(fieldName);

  const itemProps: FormItemProps = {
    required: node.rules?.some((rule) => rule.type === 'required') ?? false,
  };
  if (isRenderableLabel(rawProps.label)) itemProps.label = rawProps.label;
  itemProps.htmlFor = fieldName;
  if (fieldState.errors.length > 0) {
    // Form.Item 只消费文案和 validating 状态；取消的异步校验不会写入 errors，
    // 因而不会在 UI 上闪烁过期错误。
    itemProps.help = fieldState.errors[0];
    itemProps.validateStatus = 'error';
  } else if (fieldState.validating) {
    itemProps.validateStatus = 'validating';
  }
  return createElement(Form.Item, { key: path, ...itemProps }, element);
}

interface FieldSchemaNodeRendererProps extends SchemaNodeRendererProps {
  readonly fieldName: string;
}

/** 命名字段节点：只订阅自身状态，隐藏时保留 FormApi 中的字段值。 */
function FieldSchemaNodeRenderer({
  fieldName,
  ...props
}: FieldSchemaNodeRendererProps): React.ReactNode {
  const field = useFieldState(props.form, fieldName);
  return renderSchemaNode({ ...props, field });
}

/**
 * 在“布局节点”和“字段节点”之间建立稳定的 Hook 边界。
 * 布局节点没有 name，不调用任何订阅 Hook；字段节点转交给独立组件，因此即使上层
 * Schema 在后续 render 中改变 name，也不会违反 React Hook 调用顺序约束。
 */
function SchemaNodeRenderer(props: SchemaNodeRendererProps): React.ReactNode {
  const fieldName = props.node.name;
  return fieldName === undefined
    ? renderSchemaNode(props)
    : createElement(FieldSchemaNodeRenderer, { ...props, fieldName });
}

/**
 * 渲染 `$comp` Schema。
 * 未传入 form 时优先使用最近的 FormContext，否则创建生命周期绑定到该组件的本地表单；
 * 本地表单在卸载时 dispose，从而取消未完成校验和提交任务。
 */
export function SchemaRenderer({ schema, form, className }: SchemaRendererProps): React.ReactNode {
  const contextForm = useContext(FormContext);
  const parsedSchema = useMemo(() => parseSchema(schema), [schema]);
  const localForm = useMemo(
    () => (form === undefined && contextForm === null ? createForm({ schema }) : null),
    [contextForm, form, schema],
  );
  useOwnedFormDisposal(localForm, true);
  const activeForm = form ?? contextForm ?? localForm;
  if (activeForm === null) return null;
  // getRegistry 属于 createForm 的可选渲染扩展；基础 FormApi 实现回退到全局默认表。
  const registry = activeForm.getRegistry?.() ?? defaultRegistry;
  if (parsedSchema === undefined) throw new SchemaParseError('SchemaRenderer 根节点无效');
  return createElement(
    'div',
    { className },
    createElement(SchemaNodeRenderer, {
      node: parsedSchema,
      form: activeForm,
      path: 'root',
      registry,
    }),
  );
}

/**
 * 表单容器组件。
 * 创建独立 FormApi、提供 FormContext，并使用 `component={false}` 让 antd Form 不增加
 * 额外 DOM。调用方可通过 children 自定义布局，也可省略 children 直接渲染 Schema。
 */
export function SchemaForm<TSubmit = unknown>(props: SchemaFormProps<TSubmit>): React.ReactNode {
  const { schema, form: providedForm, options, onSubmit, children, className } = props;
  // 只按实际配置项重建，避免调用方每次 render 创建新 options
  // 对表单实例造成无意义的销毁/重建。
  /* eslint-disable react-hooks/exhaustive-deps */
  const ownedForm = useMemo<FormApi<TSubmit> | null>(() => {
    if (providedForm !== undefined) return null;
    const submitHandler = onSubmit ?? options?.onSubmit;
    const formOptions: FormOptions<TSubmit> =
      submitHandler === undefined
        ? { ...(options ?? {}), schema }
        : { ...(options ?? {}), schema, onSubmit: submitHandler };
    return createForm(formOptions);
  }, [
    providedForm,
    schema,
    options?.initialValues,
    options?.validators,
    options?.registry,
    options?.maxReactionDepth,
    options?.onSubmit,
    onSubmit,
  ]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const activeForm = providedForm ?? ownedForm;
  useOwnedFormDisposal(ownedForm, providedForm === undefined);
  if (activeForm === null) return null;
  const rendererProps: SchemaRendererProps =
    className === undefined
      ? { schema, form: activeForm }
      : { schema, form: activeForm, className };
  const content = children ?? createElement(SchemaRenderer, rendererProps);
  return createElement(
    FormContext.Provider,
    { value: activeForm },
    createElement(Form, { component: false }, content),
  );
}

/**
 * React Hook：在组件生命周期内创建并复用一个 FormApi。
 * useState 惰性初始化保证 render 不重复创建 store；卸载 effect 会调用 dispose。
 */
export function useForm<TSubmit = unknown>(options: FormOptions<TSubmit> = {}): FormApi<TSubmit> {
  const [form] = useState(() => createForm(options));
  useOwnedFormDisposal(form, true);
  return form;
}

/** 从最近的 SchemaForm 读取 FormApi；脱离 Provider 使用会抛出明确错误。 */
export function useFormContext(): FormApi {
  const form = useContext(FormContext);
  if (form === null) throw new Error('useFormContext 必须在 SchemaForm 内使用');
  return form;
}

/** 导出全局 React 组件注册便捷函数。 */
export { registerComponent };
export type { ReactComponentRegistry };

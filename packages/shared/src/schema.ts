import type { Result } from './result';
import { SchemaParseError } from './errors';
import type { ValidationError } from './errors';

/**
 * `$comp` 协议使用的 JSON 记录。
 * 采用 `unknown` 而不是宽泛类型，迫使组件适配边界自行验证输入，避免不安全值
 * 穿透到核心算法；只读标记也表达了规范化 AST 不应被运行时修改。
 */
export type JsonRecord = Readonly<Record<string, unknown>>;

/** 支持的 `{{ ... }}` 插值表达式源码；普通字符串仍按字面量处理。 */
export type ExpressionSource = string;

/**
 * 条件变化时要应用的联动动作。
 * `setVisible`/`setDisabled` 可为布尔字面量或安全 DSL；`setValue` 保留未知值，
 * 以支持 JSON 值和完整模板字符串。
 */
export interface ReactionActions {
  /** 设置目标字段可见性。 */
  readonly setVisible?: boolean | ExpressionSource;
  /** 设置目标字段禁用状态。 */
  readonly setDisabled?: boolean | ExpressionSource;
  /** 设置目标字段值；完整 `{{...}}` 字符串会在运行时求值。 */
  readonly setValue?: unknown;
}

/**
 * 绑定在具名字段上的声明式联动。
 * `when` 为真执行 `then`，为假且配置了 `else` 时执行 `else`；没有 `else`
 * 时保持当前状态。编译阶段会同时收集条件和动作中的依赖路径。
 */
export interface ReactionConfig {
  /** 形如 `{{$deps.country === 'CN'}}` 的条件表达式。 */
  readonly when: ExpressionSource;
  /** 条件为真时按固定动作顺序执行。 */
  readonly then: ReactionActions;
  /** 条件为假时可选的补偿动作。 */
  readonly else?: ReactionActions;
}

/** 必填校验规则；空字符串、空数组和 nullish 值视为空。 */
export interface RequiredRule {
  /** 固定类型标识，便于从 JSON 反序列化。 */
  readonly type: 'required';
  /** 覆盖默认错误文案。 */
  readonly message?: string;
}

/** 字符串或数组最大长度校验规则。 */
export interface MaxLengthRule {
  readonly type: 'maxLength';
  /** 允许的最大长度，必须为非负有限数。 */
  readonly value: number;
  /** 覆盖默认错误文案。 */
  readonly message?: string;
}

/** 使用字符串源码描述的正则校验规则。 */
export interface PatternRule {
  readonly type: 'pattern';
  /** `RegExp` 构造器接受的源码。 */
  readonly value: string;
  /** `RegExp` 标志，例如 `i`。 */
  readonly flags?: string;
  /** 覆盖默认错误文案。 */
  readonly message?: string;
}

/** 通过 `validatorId` 从注册表解析的同步或异步自定义规则。 */
export interface CustomRule {
  readonly type: 'custom';
  /** JSON 可序列化的校验器键名。 */
  readonly validatorId: string;
  /** 覆盖校验器返回错误的文案。 */
  readonly message?: string;
}

/** 内置规则与用户自定义规则的联合类型。 */
export type ValidationRuleConfig = RequiredRule | MaxLengthRule | PatternRule | CustomRule;

/**
 * 自定义 `$comp` Schema 协议节点。
 * 节点本身只描述静态组件树；值、可见性和禁用状态由具名节点与 FormApi 在
 * React 渲染阶段绑定。包含规则或联动的节点必须提供稳定 `name`。
 */
export interface SchemaNode {
  /** 注册表中的组件名称；`Fragment` 表示仅承载 children 的结构节点。 */
  readonly $comp: string;
  /** 扁平点号字段路径，也是联动和校验的寻址键。 */
  readonly name?: string;
  /** 传给组件的静态 JSON 属性。 */
  readonly props?: JsonRecord;
  /** 递归子节点，渲染顺序与数组声明顺序一致。 */
  readonly children?: readonly SchemaNode[];
  /** 字段校验规则，按声明顺序短路执行。 */
  readonly rules?: readonly ValidationRuleConfig[];
  /** 字段依赖联动，按声明顺序执行，后者覆盖前者。 */
  readonly reactions?: readonly ReactionConfig[];
}

/**
 * 递归规范化后的 Schema 节点。
 * 所有可变容器均已复制并冻结，可安全缓存于 `WeakMap`；该 AST 不包含动态表单值。
 */
export interface NormalizedSchemaNode extends SchemaNode {
  readonly props: JsonRecord;
  readonly children: readonly NormalizedSchemaNode[];
  readonly rules: readonly ValidationRuleConfig[];
  readonly reactions: readonly ReactionConfig[];
}

/**
 * 编译后的安全依赖表达式。
 * `deps` 在编译期间去重并保持首次出现顺序，供 DependencyTracker 建图；
 * `evaluate` 是无副作用函数，每次只读取传入快照并返回 `Result`。
 */
export interface CompiledExpression<T = unknown> {
  /** 原始源码，用于错误诊断和日志。 */
  readonly source: string;
  /** 表达式读取的字段路径集合。 */
  readonly deps: readonly string[];
  /** 在给定值快照上求值，不执行任意 JavaScript。 */
  evaluate(values: JsonRecord): Result<T, import('./errors').ExpressionError>;
}

/** 表单中单个字段的只读运行时状态快照。 */
export interface FieldState {
  /** 当前字段值。 */
  readonly value: unknown;
  /** 首条错误，便于简单 UI 直接展示。 */
  readonly error?: ValidationError;
  /** 全部错误，保留多规则扩展空间。 */
  readonly errors: readonly ValidationError[];
  /** 是否参与渲染；隐藏只卸载 UI，不清除值。 */
  readonly visible: boolean;
  /** 是否禁用输入控件。 */
  readonly disabled: boolean;
  /** 是否有异步校验正在进行。 */
  readonly validating: boolean;
  /** 是否由用户或显式 setValue 触碰过。 */
  readonly touched: boolean;
}

/**
 * 克隆 JSON 兼容的 Schema 值并冻结每一个新建容器。
 * 时间复杂度 O(M)，M 为嵌套属性总数；WeakSet 记录当前递归栈，防止循环引用。
 */
export function cloneSchemaValue(value: unknown): unknown {
  return cloneSchemaValueInternal(value, new WeakSet<object>());
}

function cloneSchemaValueInternal(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    throw new SchemaParseError('Schema 属性值不能包含循环引用');
  }
  if (Array.isArray(value)) {
    // 只沿当前递归栈检测环，而不是全局去重：同一个对象被两个兄弟属性
    // 共享引用会分别复制，让规范化结果不受调用方后续修改影响。
    ancestors.add(value);
    try {
      const cloned = value.map((item) => cloneSchemaValueInternal(item, ancestors));
      return Object.freeze(cloned);
    } finally {
      ancestors.delete(value);
    }
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // JSON Schema 通常只包含普通记录。对于特殊运行时对象（例如作为逃生口传入的
    // React 元素）保留原引用，避免改变其原型或调用自定义克隆语义。
    return value;
  }
  ancestors.add(value);
  try {
    // 使用 Reflect.get 是为了让 getter/proxy 异常进入上层 SchemaParseError，
    // 而不是在深拷贝阶段静默丢失属性。
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneSchemaValueInternal(Reflect.get(value, key), ancestors),
      });
    }
    return Object.freeze(cloned);
  } finally {
    ancestors.delete(value);
  }
}

/** 可取消异步表单操作共享的选项。外部 signal 触发时结果标记为 cancelled。 */
export interface AsyncOptions {
  readonly signal?: AbortSignal;
}

/** 传递给自定义校验器的最小上下文；禁止直接修改 values 快照。 */
export interface ValidatorContext {
  /** 正在校验的字段路径。 */
  readonly field: string;
  /** 校验开始时的表单值快照。 */
  readonly values: JsonRecord;
  /** 校验器必须监听的取消信号。 */
  readonly signal: AbortSignal;
}

/** 自定义同步/异步校验器；失败必须返回 `err(ValidationError)`。 */
export type Validator = (
  value: unknown,
  context: ValidatorContext,
) => Result<void, ValidationError> | Promise<Result<void, ValidationError>>;

/** 以 JSON 安全标识符索引的自定义校验器注册表。 */
export type ValidatorRegistry = Readonly<Record<string, Validator>>;

/** 一次字段校验运行的结果；取消不计入普通错误列表。 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly cancelled?: boolean;
}

/** 聚合整张表单校验结果，并按字段保留明细。 */
export interface FormValidationResult extends ValidationResult {
  readonly fields: Readonly<Record<string, ValidationResult>>;
}

/** 提交流程结果；成功、校验失败和取消均通过结构化字段区分。 */
export interface SubmitResult<T = unknown> {
  readonly submitted: boolean;
  readonly validation: FormValidationResult;
  readonly value?: T;
  readonly error?: import('./errors').FormSubmitError | import('./errors').AbortError;
}

/** vanilla 表单或依赖中心状态改变时调用的订阅函数。 */
export type FormListener = () => void;

/** 类型守卫：仅接受非 null 且非数组的对象记录。 */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 类型守卫：递归验证 `$comp` 节点结构。
 * 使用 WeakSet 记录当前递归祖先并拒绝循环 Schema；getter/proxy 读取异常按无效输入
 * 处理。复杂度 O(N+M)，N 为节点数、M 为属性数。
 */
export function isSchemaNode(value: unknown): value is SchemaNode {
  return isSchemaNodeInternal(value, new WeakSet<object>());
}

function isSchemaNodeInternal(value: unknown, ancestors: WeakSet<object>): value is SchemaNode {
  if (!isJsonRecord(value)) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (
      !Object.prototype.hasOwnProperty.call(value, '$comp') ||
      typeof value.$comp !== 'string' ||
      value.$comp.trim().length === 0
    ) {
      return false;
    }
    if (value.name !== undefined && typeof value.name !== 'string') {
      return false;
    }
    if (value.props !== undefined && !isJsonRecord(value.props)) {
      return false;
    }
    if (
      value.children !== undefined &&
      (!Array.isArray(value.children) ||
        // every 会共享 ancestors，使同一条祖先链上的重复引用被识别为环。
        !value.children.every((child) => isSchemaNodeInternal(child, ancestors)))
    ) {
      return false;
    }
    if (
      value.rules !== undefined &&
      (!Array.isArray(value.rules) || !value.rules.every(isValidationRuleConfig))
    ) {
      return false;
    }
    if (
      value.reactions !== undefined &&
      (!Array.isArray(value.reactions) || !value.reactions.every(isReactionConfig))
    ) {
      return false;
    }
    return true;
  } catch {
    // 运行时输入可能包含会抛错的 getter/Proxy，类型守卫统一按无效输入处理。
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/** 类型守卫：验证内置/自定义校验规则的 JSON 形状和数值边界。 */
export function isValidationRuleConfig(value: unknown): value is ValidationRuleConfig {
  try {
    if (!isJsonRecord(value) || typeof value.type !== 'string') {
      return false;
    }
    switch (value.type) {
      case 'required':
        return value.message === undefined || typeof value.message === 'string';
      case 'maxLength':
        return (
          typeof value.value === 'number' &&
          Number.isFinite(value.value) &&
          value.value >= 0 &&
          (value.message === undefined || typeof value.message === 'string')
        );
      case 'pattern':
        return (
          typeof value.value === 'string' &&
          (value.flags === undefined || typeof value.flags === 'string') &&
          (value.message === undefined || typeof value.message === 'string')
        );
      case 'custom':
        return (
          typeof value.validatorId === 'string' &&
          value.validatorId.length > 0 &&
          (value.message === undefined || typeof value.message === 'string')
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** 类型守卫：验证联动动作仅包含受支持的布尔、模板和 JSON 值。 */
export function isReactionActions(value: unknown): value is ReactionActions {
  try {
    if (!isJsonRecord(value)) {
      return false;
    }
    for (const key of ['setVisible', 'setDisabled'] as const) {
      const action = value[key];
      if (action !== undefined && typeof action !== 'boolean' && typeof action !== 'string') {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** 类型守卫：验证联动条件、then 和可选 else 的完整结构。 */
export function isReactionConfig(value: unknown): value is ReactionConfig {
  try {
    return (
      isJsonRecord(value) &&
      typeof value.when === 'string' &&
      isReactionActions(value.then) &&
      (value.else === undefined || isReactionActions(value.else))
    );
  } catch {
    return false;
  }
}

/**
 * 深度规范化 Schema，不修改调用方对象。
 * children、props、rules、reactions 都会被复制并冻结；祖先集合检测引用环。
 * 输入不符合 `$comp` 协议时抛出 `SchemaParseError`；时间复杂度 O(N+M)，空间复杂度
 * O(N+M)，分别对应节点数和静态属性总数。
 */
export function normalizeSchemaNode(node: SchemaNode): NormalizedSchemaNode {
  // 该函数也作为 shared 的公开入口，不能只依赖调用方的 TypeScript 类型；
  // 先做一次完整守卫，避免把缺少 `$comp` 的未知对象伪装成合法 AST。
  if (!isSchemaNode(node)) {
    throw new SchemaParseError('Schema 必须是包含非空 $comp 字段的对象');
  }
  return normalizeSchemaNodeInternal(node, new WeakSet<object>());
}

function normalizeSchemaNodeInternal(
  node: SchemaNode,
  ancestors: WeakSet<object>,
): NormalizedSchemaNode {
  if (ancestors.has(node)) {
    throw new SchemaParseError('Schema children 不能包含循环引用');
  }
  ancestors.add(node);
  try {
    // 先递归 children，再复制可变属性；任一步失败都会由上层统一转换为
    // SchemaParseError，避免返回半规范化 AST。
    const children = (node.children ?? []).map((child) =>
      normalizeSchemaNodeInternal(child, ancestors),
    );
    return Object.freeze({
      ...node,
      props: cloneSchemaValue(node.props ?? {}) as JsonRecord,
      children: Object.freeze(children),
      rules: cloneSchemaValue([...(node.rules ?? [])]) as readonly ValidationRuleConfig[],
      reactions: cloneSchemaValue([...(node.reactions ?? [])]) as readonly ReactionConfig[],
    });
  } catch (cause: unknown) {
    if (cause instanceof SchemaParseError) {
      throw cause;
    }
    throw new SchemaParseError('Schema 属性规范化失败', cause);
  } finally {
    ancestors.delete(node);
  }
}

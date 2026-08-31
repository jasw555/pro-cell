import {
  DependencyCycleError,
  ExpressionError,
  ReactionExecutionError,
  SchemaParseError,
  err,
  getPathValue,
  isReactionConfig,
  isSchemaNode,
  ok,
  type JsonRecord,
  type CompiledExpression,
  type NormalizedSchemaNode,
  type ReactionActions,
  type ReactionConfig,
  type Result,
  type SchemaNode,
} from '@jasw/pro-cell-shared';
import { compileExpression, isExpressionTemplate } from './expression';

/**
 * 字段值变化后发出的事件。
 * 事件在串行事务队列中同步派发；`previous`/`next` 是本次边界看到的值，
 * `source` 用于诊断是用户输入、批量更新还是某个 reaction 触发的级联。
 */
export interface DependencyEvent {
  /** 发生变化的字段路径。 */
  readonly field: string;
  /** 变化前的值。 */
  readonly previous: unknown;
  /** 变化后的值。 */
  readonly next: unknown;
  /** 可选的来源标签。 */
  readonly source: string | undefined;
}

/** 按事务顺序同步接收字段变化的监听器；抛出的异常会被包装。 */
export type DependencyListener = (event: DependencyEvent) => void;

/** 取消一个依赖监听；重复调用安全且无副作用。 */
export type Unsubscribe = () => void;

type SetterResult = Result<void, unknown> | void;

/**
 * 将 reaction 动作写回外部表单状态的适配回调。
 * 回调可以返回 Result 让 tracker 保留领域错误，也可以返回 void 表示同步成功；
 * tracker 不假设外部 store 的具体实现。
 */
export interface DependencyTrackerOptions {
  /** 读取字段当前值，用于表达式快照和 setValue 前后比较。 */
  readonly getValue?: (path: string) => unknown;
  /** 应用可见性动作。 */
  readonly setVisible?: (path: string, visible: boolean) => SetterResult;
  /** 应用禁用动作。 */
  readonly setDisabled?: (path: string, disabled: boolean) => SetterResult;
  /** 应用值动作。 */
  readonly setValue?: (path: string, value: unknown) => SetterResult;
  /** 单次事务允许处理的最大变化深度，防止运行时循环。 */
  readonly maxTransactionDepth?: number;
}

interface CompiledReaction {
  /** 用于调试/稳定排序的内部编号。 */
  readonly id: number;
  /** reaction 目标字段。 */
  readonly field: string;
  readonly config: ReactionConfig;
  readonly when: ReturnType<typeof compileExpression<boolean>> extends Result<infer T, unknown>
    ? T
    : never;
  readonly thenActions: PreparedActions;
  readonly elseActions: PreparedActions | undefined;
  readonly actionDeps: readonly string[];
}

/**
 * 预编译动作的私有标记。
 *
 * `setValue` 允许任意 JSON 值；若使用普通字符串键作为标记，用户恰好传入同名对象
 * 就可能被误判为编译表达式。使用模块私有 Symbol 可以在不改变公开协议的前提下
 * 完全隔离运行时元数据。
 */
const preparedExpressionMarker = Symbol('pro-cell-prepared-expression');

interface PreparedExpression {
  /** 模块私有标记，避免把用户的 setValue 对象误当编译表达式。 */
  readonly [preparedExpressionMarker]: true;
  /** 编译后可重复求值的纯表达式。 */
  readonly compiled: CompiledExpression<unknown>;
}

interface PreparedActions {
  readonly setVisible?: unknown;
  readonly setDisabled?: unknown;
  readonly setValue?: unknown;
}

interface PendingChange {
  /** 队列中的字段路径。 */
  readonly field: string;
  /** 入队时的旧值。 */
  readonly previous: unknown;
  /** 入队时的新值。 */
  readonly next: unknown;
  /** 触发链来源。 */
  readonly source: string | undefined;
  /**
   * 该变化在当前级联链中的深度。
   *
   * 深度表达因果路径而非队列位置：根通知为 1，由它直接产生的
   * 任意多个变化都是 2。因此宽扇出不会被误判为过深级联。
   */
  readonly depth: number;
}

function isFailure(
  value: SetterResult,
): value is Exclude<SetterResult, void> & { readonly ok: false } {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

/**
 * 追踪字段依赖并执行声明式联动。
 *
 * 采用拓扑排序算法检测循环依赖，时间复杂度 O(V+E)
 *
 * 图边从依赖字段指向受影响字段（A 读取 B 时建立 B -> A）。通知通过串行队列处理，
 * 使级联顺序确定且受 maxTransactionDepth 限制。每条 reaction 快照只读取已编译的
 * 依赖，因此通知成本为 O(D)，D 为受影响字段数（不含用户回调本身的成本）。
 */
export class DependencyTracker {
  private readonly options: DependencyTrackerOptions;
  /** 依赖字段 -> 被影响字段的邻接表，例如 B -> A 表示 A 读取 B。 */
  private readonly edges = new Map<string, Set<string>>();
  /** 按字段保存 reaction，数组顺序即 Schema 声明顺序。 */
  private readonly reactions = new Map<string, CompiledReaction[]>();
  /** 每个字段的监听集合；Set 保证同一函数不会重复调用。 */
  private readonly listeners = new Map<string, Set<DependencyListener>>();
  /** 无外部 getter 时使用的 tracker 内部值镜像。 */
  private readonly values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  /** 当前事务已提交的临时值；事务完全排空前优先于外部 getter。 */
  private readonly transactionValues = new Map<string, unknown>();
  /** 最近一次 reaction 设置的可见性，默认值由 getVisible 提供。 */
  private readonly visible = new Map<string, boolean>();
  /** 最近一次 reaction 设置的禁用状态，默认值由 getDisabled 提供。 */
  private readonly disabled = new Map<string, boolean>();
  /** 串行事务队列；入队顺序决定同一批 reaction 的可观察顺序。 */
  private readonly queue: PendingChange[] = [];
  private processing = false;
  /** 当前队列项的因果深度；仅在同步排空事务期间有效。 */
  private currentTransactionDepth = 0;
  private disposed = false;
  private nextReactionId = 1;
  private readonly maxTransactionDepth: number;

  /** 创建依赖中心；不会自动注册 Schema，便于先构建图再初始化值。 */
  public constructor(options: DependencyTrackerOptions = {}) {
    this.options = options;
    const requestedDepth = options.maxTransactionDepth;
    this.maxTransactionDepth =
      typeof requestedDepth === 'number' && Number.isFinite(requestedDepth)
        ? Math.max(1, Math.floor(requestedDepth))
        : 1000;
  }

  /**
   * 递归注册整棵 Schema 的 reaction。
   * 过程先编译所有条件/动作并暂存边，再运行拓扑检测；任何语法错误或依赖环都会
   * 回滚到调用前状态。遍历与建图复杂度 O(V+E)，V 为字段顶点、E 为依赖边。
   */
  public registerSchema(
    schema: SchemaNode | NormalizedSchemaNode,
  ): Result<void, SchemaParseError | ExpressionError> {
    if (this.disposed) {
      return err(new SchemaParseError('DependencyTracker 已销毁'));
    }
    try {
      if (!isSchemaNode(schema)) {
        return err(new SchemaParseError('无法注册非法 Schema'));
      }
    } catch (cause: unknown) {
      return err(new SchemaParseError('无法读取 Schema 联动配置', cause));
    }
    const beforeEdges = this.cloneEdges();
    const beforeReactions = this.cloneReactions();
    try {
      const visit = (
        node: SchemaNode,
        fallbackPath: string,
      ): Result<void, SchemaParseError | ExpressionError> => {
        const field = node.name ?? fallbackPath;
        if (node.name !== undefined && node.name.trim().length === 0) {
          return err(new SchemaParseError(`联动字段名称不能为空（路径：${fallbackPath}）`));
        }
        if (
          (node.reactions?.length ?? 0) > 0 &&
          (node.name === undefined || node.name.trim().length === 0)
        ) {
          return err(new SchemaParseError(`联动字段必须提供 name（路径：${fallbackPath}）`));
        }
        for (const reaction of node.reactions ?? []) {
          const registered = this.registerReactionInternal(field, reaction);
          if (!registered.ok) {
            return registered;
          }
        }
        for (const [index, child] of (node.children ?? []).entries()) {
          const childPath = child.name ?? `${field}.${index}`;
          const result = visit(child, childPath);
          if (!result.ok) {
            return result;
          }
        }
        return ok(undefined);
      };
      const registered = visit(schema, schema.name ?? 'root');
      if (!registered.ok) {
        this.restore(beforeEdges, beforeReactions);
        return registered;
      }
      const cycle = this.detectCycle();
      if (cycle) {
        this.restore(beforeEdges, beforeReactions);
        // 依赖环直接抛出，调用方可以把图结构错误与表达式编译失败分开处理。
        throw new DependencyCycleError(cycle);
      }
      return ok(undefined);
    } catch (cause: unknown) {
      if (cause instanceof DependencyCycleError) {
        throw cause;
      }
      this.restore(beforeEdges, beforeReactions);
      return err(new SchemaParseError('注册 Schema 联动时发生未知错误', cause));
    }
  }

  /** registerSchema 的简写，便于命令式初始化。 */
  public register(
    schema: SchemaNode | NormalizedSchemaNode,
  ): Result<void, SchemaParseError | ExpressionError> {
    return this.registerSchema(schema);
  }

  /**
   * 注册单条 reaction；若新边闭合环则回滚并抛出 DependencyCycleError。
   * 该方法适合动态增加联动，批量 Schema 更推荐使用 registerSchema。
   */
  public registerReaction(field: string, config: ReactionConfig): Result<void, ExpressionError> {
    let source = '';
    try {
      source =
        typeof config === 'object' &&
        config !== null &&
        'when' in config &&
        typeof config.when === 'string'
          ? config.when
          : '';
    } catch (cause: unknown) {
      return err(new ExpressionError(source, '联动配置读取失败', 0, cause));
    }
    if (this.disposed) {
      return err(new ExpressionError(source, 'DependencyTracker 已销毁', 0));
    }
    if (typeof field !== 'string' || field.trim().length === 0) {
      return err(new ExpressionError(source, '联动字段名称不能为空', 0));
    }
    try {
      if (!isReactionConfig(config)) {
        return err(new ExpressionError(source, '联动配置格式无效', 0));
      }
    } catch (cause: unknown) {
      return err(new ExpressionError(source, '联动配置读取失败', 0, cause));
    }
    const beforeEdges = this.cloneEdges();
    const beforeReactions = this.cloneReactions();
    try {
      const result = this.registerReactionInternal(field, config);
      if (!result.ok) {
        return result;
      }
      const cycle = this.detectCycle();
      if (cycle) {
        this.restore(beforeEdges, beforeReactions);
        throw new DependencyCycleError(cycle);
      }
      return ok(undefined);
    } catch (cause: unknown) {
      this.restore(beforeEdges, beforeReactions);
      if (cause instanceof DependencyCycleError) {
        throw cause;
      }
      return err(new ExpressionError(source, '注册联动时发生未知错误', undefined, cause));
    }
  }

  /**
   * 按依赖优先拓扑顺序执行初始 reaction。
   * 初始化使用独立 transactionValues 快照，动作产生的内部通知不会在同一轮被重复消费；
   * 失败时返回 ReactionExecutionError，并清理临时队列。复杂度 O(V+E+R)。
   */
  public initialize(values: JsonRecord = {}): Result<void, ReactionExecutionError> {
    if (this.disposed) {
      return err(new ReactionExecutionError('DependencyTracker 已销毁'));
    }
    this.transactionValues.clear();
    try {
      // 先完成枚举再修改内部状态，读取异常不会留下半提交事务。
      const entries = Object.entries(values);
      for (const field of Object.keys(this.values)) {
        delete this.values[field];
      }
      for (const [field, value] of entries) {
        this.values[field] = value;
        this.transactionValues.set(field, value);
      }
    } catch (cause: unknown) {
      this.transactionValues.clear();
      return err(new ReactionExecutionError('初始化联动值读取失败', undefined, cause));
    }
    const order = this.topologicalOrder();
    // 初始化直接按拓扑顺序执行，不属于某个 notify 级联链。
    this.currentTransactionDepth = 0;
    this.processing = true;
    try {
      for (const field of order) {
        const result = this.runReactions(field, undefined, undefined, 'initialize');
        if (!result.ok) {
          return result;
        }
      }
      // reaction 可能只写入没有依赖边的孤立字段；仍按声明顺序初始化它们。
      const ordered = new Set(order);
      for (const field of this.reactions.keys()) {
        if (!ordered.has(field)) {
          const result = this.runReactions(field, undefined, undefined, 'initialize');
          if (!result.ok) {
            return result;
          }
        }
      }
      // 初始化已按依赖优先拓扑顺序完成。动作 setter 可能为运行时级联入队相同变化，
      // 此处丢弃队列，避免初始阶段把已处理的 reaction 再执行一次。
      return ok(undefined);
    } finally {
      this.processing = false;
      this.queue.length = 0;
      this.transactionValues.clear();
      this.currentTransactionDepth = 0;
    }
  }

  /**
   * 订阅一个字段。监听器同步调用且遵循注册顺序；取消函数可重复调用。
   * 订阅本身平均 O(1)，通知成本与该字段监听器和受影响顶点数相关。
   */
  public subscribe(field: string, listener: DependencyListener): Unsubscribe {
    const set = this.listeners.get(field) ?? new Set<DependencyListener>();
    set.add(listener);
    this.listeners.set(field, set);
    return (): void => {
      const current = this.listeners.get(field);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(field);
      }
    };
  }

  /**
   * 通知依赖字段值变化。
   * `Object.is` 相等值直接去重；不同值进入串行队列，级联 `setValue` 会继续排队，
   * 从而避免递归调用栈增长。当前正在处理事务时只入队、不重入 drainQueue。
   */
  public notify(
    field: string,
    previous: unknown,
    next: unknown,
    source?: string,
  ): Result<void, ReactionExecutionError> {
    if (this.disposed) {
      return err(new ReactionExecutionError('DependencyTracker 已销毁', field));
    }
    if (Object.is(previous, next)) {
      return ok(undefined);
    }
    // 公开通知开启新链；处理期的重入通知是当前事件的直接子级。
    // 把深度写入队列项，可以在 FIFO 队列交错处理多个分支时保留正确因果关系。
    const depth = this.processing ? this.currentTransactionDepth + 1 : 1;
    this.queue.push({ field, previous, next, source, depth });
    if (this.processing) {
      return ok(undefined);
    }
    this.processing = true;
    try {
      return this.drainQueue();
    } finally {
      this.processing = false;
      this.transactionValues.clear();
    }
  }

  /**
   * 清空串行变化队列，并按“先监听器、后依赖 reaction”顺序派发。
   * 限制的是从根通知到当前变化的因果路径深度，而不是已处理的事件总数；
   * 因此同一层有大量独立目标时不会误触发保护。finally 始终清理剩余项，
   * 确保失败事务不会污染下一次 notify。
   */
  private drainQueue(): Result<void, ReactionExecutionError> {
    let cursor = 0;
    try {
      while (cursor < this.queue.length) {
        const change = this.queue[cursor] as PendingChange;
        cursor += 1;
        /* c8 ignore next 2 -- 队列只会追加完整变化记录，此分支仅作防御。 */
        if (!change) {
          continue;
        }
        if (change.depth > this.maxTransactionDepth) {
          return err(
            new ReactionExecutionError('联动事务超过最大深度，可能存在运行时循环', change.field),
          );
        }
        this.currentTransactionDepth = change.depth;
        // 只有变化到达串行队列头部才提交。重入 notify 不能修改当前事件尚未完成
        // 的 reaction 所观察到的快照。
        this.values[change.field] = change.next;
        // 只有当前正在排空的变化可见；重入通知继续排队，不会泄漏到更早事件的表达式快照。
        this.transactionValues.set(change.field, change.next);
        const event: DependencyEvent = {
          field: change.field,
          previous: change.previous,
          next: change.next,
          source: change.source,
        };
        for (const listener of this.listeners.get(change.field) ?? []) {
          try {
            listener(event);
          } catch (cause: unknown) {
            return err(
              new ReactionExecutionError(
                `字段 “${change.field}” 的订阅者执行失败`,
                change.field,
                cause,
              ),
            );
          }
        }
        for (const target of this.edges.get(change.field) ?? []) {
          const result = this.runReactions(
            target,
            change.previous,
            change.next,
            change.source ?? change.field,
          );
          if (!result.ok) {
            return result;
          }
        }
      }
      return ok(undefined);
    } finally {
      // 失败事务不能把未处理变化泄漏到下一次公开 notify。
      this.queue.length = 0;
      this.currentTransactionDepth = 0;
    }
  }

  /** 读取表达式求值使用的当前值（事务覆盖优先于外部 getter）。 */
  public getValue(path: string): unknown {
    return this.readValue(path);
  }

  /** 返回 reaction 最近设置的可见性；未设置时默认为 true。 */
  public getVisible(path: string): boolean {
    return this.visible.get(path) ?? true;
  }

  /** 返回 reaction 最近设置的禁用状态；未设置时默认为 false。 */
  public getDisabled(path: string): boolean {
    return this.disabled.get(path) ?? false;
  }

  /** 返回当前图的拓扑顺序（依赖字段在前）；有环时返回部分顺序。 */
  public getTopologicalOrder(): readonly string[] {
    return this.topologicalOrder();
  }

  /** 清除注册、监听和队列；销毁后的写操作返回领域错误。 */
  public dispose(): void {
    this.disposed = true;
    this.edges.clear();
    this.reactions.clear();
    this.listeners.clear();
    this.queue.length = 0;
    this.currentTransactionDepth = 0;
  }

  /**
   * 编译并写入一条 reaction 的内部实现。
   * 条件与 then/else 动作中的模板都会被预编译，依赖集合去重后建立 dependency -> field
   * 边；该方法本身不做环检测，由外层完成事务式回滚。
   */
  private registerReactionInternal(
    field: string,
    config: ReactionConfig,
  ): Result<void, ExpressionError> {
    const when = compileExpression<boolean>(config.when);
    if (!when.ok) {
      return when;
    }
    const thenActions = this.prepareActions(config.then);
    if (!thenActions.ok) {
      return thenActions;
    }
    const elseActions =
      config.else === undefined
        ? ok<PreparedActions | undefined>(undefined)
        : this.prepareActions(config.else);
    if (!elseActions.ok) {
      return elseActions;
    }
    const actionDeps = [
      ...this.preparedDependencies(thenActions.value),
      ...this.preparedDependencies(elseActions.value),
    ];
    const reaction: CompiledReaction = {
      id: this.nextReactionId++,
      field,
      config,
      when: when.value,
      thenActions: thenActions.value,
      elseActions: elseActions.value,
      actionDeps: [...new Set([...when.value.deps, ...actionDeps])],
    };
    const list = this.reactions.get(field) ?? [];
    list.push(reaction);
    this.reactions.set(field, list);
    for (const dependency of reaction.actionDeps) {
      const dependents = this.edges.get(dependency) ?? new Set<string>();
      dependents.add(field);
      this.edges.set(dependency, dependents);
    }
    // 没有依赖的字段也必须作为图顶点保留，才能参与拓扑排序和稳定初始化。
    if (!this.edges.has(field)) {
      this.edges.set(field, new Set<string>());
    }
    return ok(undefined);
  }

  /**
   * 执行一个字段声明的全部 reaction。
   * 每条 reaction 使用只包含其依赖的快照，既避免读取无关字段，也保证同一事务中
   * 前置 reaction 的 setValue 能被后续 reaction 观察到；数组顺序决定覆盖关系。
   */
  private runReactions(
    field: string,
    _previous: unknown,
    _next: unknown,
    source?: string,
  ): Result<void, ReactionExecutionError> {
    const list = this.reactions.get(field) ?? [];
    for (const reaction of list) {
      const snapshot = this.readSnapshot(field, reaction.actionDeps);
      if (!snapshot.ok) {
        return snapshot;
      }
      const condition = reaction.when.evaluate(snapshot.value);
      if (!condition.ok) {
        return err(
          new ReactionExecutionError(`字段 “${field}” 的联动条件求值失败`, field, condition.error),
        );
      }
      const actions = condition.value ? reaction.thenActions : reaction.elseActions;
      if (!actions) {
        continue;
      }
      const result = this.applyActions(field, actions, source, snapshot.value);
      if (!result.ok) {
        return result;
      }
    }
    return ok(undefined);
  }

  /**
   * 按固定顺序应用一组动作：可见性 -> 禁用 -> 值。
   * 每一步先求值、再调用外部 setter；setValue 成功后才入队新的变化，避免失败动作
   * 产生虚假的级联事件。动作求值错误统一包装为 ReactionExecutionError。
   */
  private applyActions(
    field: string,
    actions: PreparedActions,
    source?: string,
    snapshot: JsonRecord = Object.create(null) as JsonRecord,
  ): Result<void, ReactionExecutionError> {
    const visible = this.evaluateBooleanAction(actions.setVisible, field, snapshot);
    if (!visible.ok) {
      return visible;
    }
    if (actions.setVisible !== undefined) {
      const result = this.invokeSetter(this.options.setVisible, field, visible.value, 'setVisible');
      if (!result.ok) {
        return result;
      }
      // 只有外部 setter 成功后才更新 tracker 镜像；失败动作不应伪造内部状态。
      this.visible.set(field, visible.value);
    }

    const disabled = this.evaluateBooleanAction(actions.setDisabled, field, snapshot);
    if (!disabled.ok) {
      return disabled;
    }
    if (actions.setDisabled !== undefined) {
      const result = this.invokeSetter(
        this.options.setDisabled,
        field,
        disabled.value,
        'setDisabled',
      );
      if (!result.ok) {
        return result;
      }
      // 与可见性动作一致，失败时保留上一次已提交的禁用状态。
      this.disabled.set(field, disabled.value);
    }

    if (actions.setValue !== undefined) {
      const evaluated = this.evaluatePreparedValue(actions.setValue, snapshot);
      if (!evaluated.ok) {
        return err(
          new ReactionExecutionError(
            `字段 “${field}” 的 setValue 表达式无效`,
            field,
            evaluated.error,
          ),
        );
      }
      let previous: unknown;
      try {
        previous = this.readValue(field);
      } catch (cause: unknown) {
        return err(new ReactionExecutionError(`字段 “${field}” 的当前值读取失败`, field, cause));
      }
      const result = this.invokeSetter(this.options.setValue, field, evaluated.value, 'setValue');
      if (!result.ok) {
        return result;
      }
      // 当前事务前面的动作可能为同一字段留下临时覆盖；读取 store 前移除它，
      // 让 setter 的规范化结果能够被观察到。
      this.transactionValues.delete(field);
      let next: unknown;
      try {
        const observed = this.readValue(field);
        // 独立 tracker 可能连接到“setter 先记录、下一 tick 才更新 getter”的适配器。
        // 若 getter 仍返回旧值，则采用表达式结果维持同步联动约定；getter 异常
        // getter 异常继续由 ReactionExecutionError 承接。
        next =
          Object.is(observed, previous) && !Object.is(evaluated.value, previous)
            ? evaluated.value
            : observed;
      } catch (cause: unknown) {
        return err(new ReactionExecutionError(`字段 “${field}” 的新值读取失败`, field, cause));
      }
      // 记录 setter 实际提交/推断出的最终值，而不是未经适配器规范化的请求值，
      // 让后续无外部 getter 的 reaction 与 getValue 保持一致。
      this.values[field] = next;
      this.transactionValues.set(field, next);
      if (!Object.is(previous, next)) {
        this.queue.push({
          field,
          previous,
          next,
          source,
          depth: this.currentTransactionDepth + 1,
        });
      }
    }
    return ok(undefined);
  }

  /**
   * 调用外部 setter 并统一处理返回的 Err 或抛出的未知异常。
   * 这是 tracker 与表单 store 的错误隔离边界，保证用户回调不会逃出 notify API。
   */
  private invokeSetter<T>(
    setter: ((path: string, value: T) => SetterResult) | undefined,
    field: string,
    value: T,
    action: string,
  ): Result<void, ReactionExecutionError> {
    try {
      const result = setter?.(field, value);
      if (isFailure(result)) {
        return err(
          new ReactionExecutionError(`字段 “${field}” 的 ${action} 执行失败`, field, result.error),
        );
      }
      return ok(undefined);
    } catch (cause: unknown) {
      return err(new ReactionExecutionError(`字段 “${field}” 的 ${action} 执行异常`, field, cause));
    }
  }

  /**
   * 求值可见性/禁用动作并验证结果确实为 boolean。
   * 普通 boolean 原样返回；模板表达式使用当前 reaction 快照，避免一次动作读取到
   * 另一动作尚未提交的中间状态。
   */
  private evaluateBooleanAction(
    value: unknown,
    field: string,
    snapshot?: JsonRecord,
  ): Result<boolean, ReactionExecutionError> {
    if (value === undefined) {
      return ok(false);
    }
    if (typeof value === 'boolean') {
      return ok(value);
    }
    const current =
      snapshot === undefined
        ? this.readSnapshot(field, this.preparedDependenciesForValue(value))
        : ok(snapshot);
    if (!current.ok) {
      return current;
    }
    const evaluated = this.evaluatePreparedValue(value, current.value);
    if (!evaluated.ok) {
      return err(
        new ReactionExecutionError(`字段 “${field}” 的布尔动作表达式无效`, field, evaluated.error),
      );
    }
    if (typeof evaluated.value !== 'boolean') {
      return err(new ReactionExecutionError(`字段 “${field}” 的布尔动作必须返回 boolean`, field));
    }
    return ok(evaluated.value);
  }

  /** 将动作中的完整模板预编译；普通字符串和值保持字面量。 */
  private prepareActions(actions: ReactionActions): Result<PreparedActions, ExpressionError> {
    const prepare = (value: unknown): Result<unknown, ExpressionError> => {
      if (!isExpressionTemplate(value)) {
        return ok(value);
      }
      const compiled = compileExpression(value);
      return compiled.ok
        ? ok({
            [preparedExpressionMarker]: true,
            compiled: compiled.value,
          } satisfies PreparedExpression)
        : compiled;
    };
    const setVisible = prepare(actions.setVisible);
    if (!setVisible.ok) return setVisible;
    const setDisabled = prepare(actions.setDisabled);
    if (!setDisabled.ok) return setDisabled;
    const setValue = prepare(actions.setValue);
    if (!setValue.ok) return setValue;
    return ok({
      ...(actions.setVisible === undefined ? {} : { setVisible: setVisible.value }),
      ...(actions.setDisabled === undefined ? {} : { setDisabled: setDisabled.value }),
      ...(actions.setValue === undefined ? {} : { setValue: setValue.value }),
    });
  }

  /** 收集动作模板依赖，用于与 when 依赖合并建图。 */
  private preparedDependencies(actions: PreparedActions | undefined): readonly string[] {
    if (actions === undefined) return [];
    const dependencies: string[] = [];
    for (const value of [actions.setVisible, actions.setDisabled, actions.setValue]) {
      if (this.isPreparedExpression(value)) dependencies.push(...value.compiled.deps);
    }
    return dependencies;
  }

  /** 求值预编译模板或直接返回字面量。 */
  private evaluatePreparedValue(
    value: unknown,
    values: JsonRecord,
  ): Result<unknown, ExpressionError> {
    return this.isPreparedExpression(value) ? value.compiled.evaluate(values) : ok(value);
  }

  /** 结构化判断内部预编译表达式标记。 */
  private isPreparedExpression(value: unknown): value is PreparedExpression {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    try {
      return (
        Object.prototype.hasOwnProperty.call(value, preparedExpressionMarker) &&
        Object.getOwnPropertyDescriptor(value, preparedExpressionMarker)?.value === true &&
        'compiled' in value
      );
    } catch {
      // 外部传入的 Proxy 可能拒绝属性探测；此时按普通字面量处理，
      // 让上层 setter/校验边界决定如何处理该值，而不是泄漏 Proxy 异常。
      return false;
    }
  }

  /** 读取字段值，并让当前事务的临时覆盖优先于持久值。 */
  private readValue(path: string): unknown {
    if (this.options.getValue) {
      const external = this.options.getValue(path);
      return this.transactionValues.has(path) ? this.transactionValues.get(path) : external;
    }
    if (this.transactionValues.has(path)) {
      return this.transactionValues.get(path);
    }
    return getPathValue(this.values, path);
  }

  /** 读取 reaction 依赖快照，并将 getter 异常转换为 ReactionExecutionError。 */
  private readSnapshot(
    field: string,
    dependencies: readonly string[] = [],
  ): Result<JsonRecord, ReactionExecutionError> {
    try {
      return ok(this.snapshotValues(dependencies));
    } catch (cause: unknown) {
      return err(new ReactionExecutionError(`字段 “${field}” 的依赖值读取失败`, field, cause));
    }
  }

  /**
   * 创建依赖字段快照。
   * 通过 Set 去重路径，并先调用外部 getter 再应用事务覆盖，以便暴露 getter 失败；
   * 结果使用无原型对象，降低特殊键影响。
   */
  private snapshotValues(dependencies: readonly string[] = []): JsonRecord {
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const field of new Set(dependencies)) {
      if (this.options.getValue) {
        // 即使同一路径存在事务覆盖，也先调用外部 getter，让 getter 失败能够被暴露。
        const external = this.options.getValue(field);
        snapshot[field] = this.transactionValues.has(field)
          ? this.transactionValues.get(field)
          : external;
      } else {
        snapshot[field] = this.readValue(field);
      }
    }
    return snapshot;
  }

  /** 返回单个预编译动作值的依赖列表。 */
  private preparedDependenciesForValue(value: unknown): readonly string[] {
    return this.isPreparedExpression(value) ? value.compiled.deps : [];
  }

  /** 深复制邻接表，供注册事务失败时恢复。复杂度 O(V+E)。 */
  private cloneEdges(): Map<string, Set<string>> {
    return new Map([...this.edges.entries()].map(([key, value]) => [key, new Set(value)]));
  }

  /** 复制 reaction 数组但保留不可变编译记录，供事务回滚。复杂度 O(R)。 */
  private cloneReactions(): Map<string, CompiledReaction[]> {
    return new Map([...this.reactions.entries()].map(([key, value]) => [key, [...value]]));
  }

  /** 恢复注册前的图和 reaction 快照。 */
  private restore(
    edges: Map<string, Set<string>>,
    reactions: Map<string, CompiledReaction[]>,
  ): void {
    this.edges.clear();
    for (const [key, value] of edges) {
      this.edges.set(key, new Set(value));
    }
    this.reactions.clear();
    for (const [key, value] of reactions) {
      this.reactions.set(key, [...value]);
    }
  }

  /**
   * 使用 Kahn 算法生成依赖优先顺序。
   * 先计算入度，再从入度为零的顶点逐个削减；时间复杂度 O(V+E)，空间复杂度 O(V)。
   */
  private topologicalOrder(): readonly string[] {
    const indegree = new Map<string, number>();
    for (const vertex of this.edges.keys()) {
      indegree.set(vertex, 0);
    }
    for (const dependents of this.edges.values()) {
      for (const dependent of dependents) {
        indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
      }
    }
    const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([key]) => key);
    const order: string[] = [];
    let cursor = 0;
    while (cursor < queue.length) {
      const vertex = queue[cursor] as string;
      cursor += 1;
      order.push(vertex);
      for (const dependent of this.edges.get(vertex) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) {
          queue.push(dependent);
        }
      }
    }
    return order;
  }

  /** 运行 Kahn 算法；若未覆盖全部顶点，再解析一条可读的环路径。 */
  private detectCycle(): readonly string[] | undefined {
    const order = this.topologicalOrder();
    if (order.length === this.edges.size) {
      return undefined;
    }
    return this.findCycle();
  }

  /**
   * 在 Kahn 未覆盖的剩余图上用 DFS 找到一条可读闭合路径。
   * visiting 集合代表当前递归栈，遇到回边即可截取 cycle；复杂度 O(V+E)。
   */
  private findCycle(): readonly string[] | undefined {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const visit = (vertex: string): readonly string[] | undefined => {
      if (visiting.has(vertex)) {
        const start = stack.indexOf(vertex);
        return this.normalizeCycle([...stack.slice(start), vertex]);
      }
      if (visited.has(vertex)) {
        return undefined;
      }
      visiting.add(vertex);
      stack.push(vertex);
      for (const dependent of this.edges.get(vertex) ?? []) {
        const cycle = visit(dependent);
        if (cycle) {
          return cycle;
        }
      }
      stack.pop();
      visiting.delete(vertex);
      visited.add(vertex);
      return undefined;
    };
    for (const vertex of this.edges.keys()) {
      const cycle = visit(vertex);
      if (cycle) {
        return cycle;
      }
    }
    return undefined;
  }

  /** 将环旋转到字典序最小顶点，保证错误路径在不同遍历顺序下稳定。 */
  private normalizeCycle(cycle: readonly string[]): readonly string[] {
    if (cycle.length <= 1) {
      return cycle;
    }
    const vertices = cycle.slice(0, -1);
    let smallestIndex = 0;
    for (let index = 1; index < vertices.length; index += 1) {
      if ((vertices[index] ?? '') < (vertices[smallestIndex] ?? '')) {
        smallestIndex = index;
      }
    }
    const rotated = [...vertices.slice(smallestIndex), ...vertices.slice(0, smallestIndex)];
    return [...rotated, rotated[0] ?? ''];
  }
}

import { AbortError, ValidationEngineError, ValidationError } from './errors';
import type {
  JsonRecord,
  ValidationResult,
  ValidationRuleConfig,
  Validator,
  ValidatorContext,
  ValidatorRegistry,
} from './schema';
import { err, ok, type Result } from './result';

/**
 * 在运行时验证外部校验器是否返回形如 Result 的对象。
 * 这里不能依赖 `instanceof`（Result 是接口），因此只检查判别字段和失败分支；
 * 真正的错误类校验由 `runValidator` 完成。
 */
function isResultLike(value: unknown): value is Result<unknown, unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const okValue = value.ok;
  if (okValue === true) {
    return true;
  }
  return okValue === false && 'error' in value;
}

/**
 * 判断 required 规则视为“空”的值。
 * `0`、`false` 和包含元素的数组均属于有效输入；时间复杂度 O(1)。
 */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * 执行一条内置规则。
 * 返回 `undefined` 表示通过或该规则主动跳过；返回 ValidationError 表示失败。
 * 非 required 规则对空值短路，避免把“可选字段未填写”误报为格式错误。
 * 正则校验每次创建独立 RegExp 并重置 lastIndex，避免带 `g` 标志时跨调用污染状态。
 */
export function validateBuiltInRule(
  value: unknown,
  rule: ValidationRuleConfig,
  field?: string,
): ValidationError | undefined {
  if (rule.type === 'required') {
    return isEmptyValue(value)
      ? new ValidationError(rule.message ?? '此字段为必填项', { field, rule: rule.type })
      : undefined;
  }

  // 可选规则忽略空值，必填判断由 required 负责。
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (rule.type === 'maxLength') {
    const length = typeof value === 'string' || Array.isArray(value) ? value.length : undefined;
    return length !== undefined && length > rule.value
      ? new ValidationError(rule.message ?? `长度不能超过 ${rule.value}`, {
          field,
          rule: rule.type,
        })
      : undefined;
  }

  if (rule.type === 'pattern') {
    if (typeof value !== 'string') {
      return undefined;
    }
    try {
      const expression = new RegExp(rule.value, rule.flags);
      expression.lastIndex = 0;
      return expression.test(value)
        ? undefined
        : new ValidationError(rule.message ?? '字段格式不正确', { field, rule: rule.type });
    } catch (cause: unknown) {
      return new ValidationError('校验规则中的正则表达式无效', {
        field,
        rule: rule.type,
        cause,
      });
    }
  }

  return undefined;
}

/**
 * 创建可注册/复用的 required 校验器。
 * 返回的函数是纯适配层，不保存字段状态；单次执行时间复杂度 O(1)。
 */
export function required(message?: string): Validator {
  return (value: unknown, context: ValidatorContext): Result<void, ValidationError> => {
    const failure = validateBuiltInRule(
      value,
      { type: 'required', ...(message === undefined ? {} : { message }) },
      context.field,
    );
    return failure === undefined ? ok(undefined) : err(failure);
  };
}

/**
 * 创建字符串/数组最大长度校验器。
 * 非字符串、非数组和空值由内置规则语义跳过；单次执行时间复杂度 O(1)。
 */
export function maxLength(limit: number, message?: string): Validator {
  return (value: unknown, context: ValidatorContext): Result<void, ValidationError> => {
    const failure = validateBuiltInRule(
      value,
      { type: 'maxLength', value: limit, ...(message === undefined ? {} : { message }) },
      context.field,
    );
    return failure === undefined ? ok(undefined) : err(failure);
  };
}

/**
 * 创建正则校验器。
 * 正则匹配复杂度取决于表达式和值长度（通常 O(L)），调用方应避免传入可能灾难性
 * 回溯的表达式；无效正则会被包装成 ValidationError 而不是抛出原生异常。
 */
export function pattern(source: string, flags = '', message?: string): Validator {
  return (value: unknown, context: ValidatorContext): Result<void, ValidationError> => {
    const failure = validateBuiltInRule(
      value,
      {
        type: 'pattern',
        value: source,
        flags,
        ...(message === undefined ? {} : { message }),
      },
      context.field,
    );
    return failure === undefined ? ok(undefined) : err(failure);
  };
}

/**
 * 在稳定的错误边界内执行自定义校验器。
 *
 * 校验器可以返回同步或异步 Result，但不能直接抛出或返回任意对象；未知异常统一
 * 封装为 ValidationEngineError。每次 await 前后都检查 signal，确保过期结果不会
 * 被当作当前校验成功/失败写回表单。时间复杂度由用户校验器决定。
 */
export async function runValidator(
  validator: Validator,
  value: unknown,
  context: ValidatorContext,
): Promise<Result<void, ValidationError | ValidationEngineError | AbortError>> {
  if (context.signal.aborted) {
    return err(new AbortError());
  }
  // 不能假设第三方 validator 一定把 signal 传给底层请求。用一个唯一哨兵与
  // validator Promise 竞速，使“忽略 signal 且永不结束”的实现也能及时取消；
  // 无论哪一方先完成，finally 都会解除监听器。竞速不会吞掉后续 Promise 的拒绝，
  // 因为 Promise.race 已经为两个分支安装了 rejection handler。
  const aborted = Symbol('pro-cell-validator-aborted');
  let removeAbortListener: (() => void) | undefined;
  try {
    let resolveAbort: ((marker: typeof aborted) => void) | undefined;
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      resolveAbort = resolve;
    });
    const onAbort = (): void => resolveAbort?.(aborted);
    // 首次 aborted 检查与监听器注册之间存在竞态窗口，因此先无条件注册，
    // 再检查一次 signal；若窗口内已经取消，手动触发同一个 abort 分支即可补偿。
    context.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => context.signal.removeEventListener('abort', onAbort);
    if (context.signal.aborted) onAbort();
    const validatorPromise = Promise.resolve().then(() => {
      // 监听器注册后到微任务真正执行之间仍可能发生 abort；再次检查可避免
      // 已取消任务启动用户校验器并产生不必要的网络/副作用。
      if (context.signal.aborted) {
        throw new AbortError('校验已取消', context.signal.reason);
      }
      return validator(value, context);
    });
    const raced: unknown = await Promise.race([validatorPromise, abortPromise]);
    removeAbortListener?.();
    removeAbortListener = undefined;
    if (raced === aborted) {
      return err(new AbortError('校验已取消', context.signal.reason));
    }
    const result: unknown = raced;
    if (context.signal.aborted) {
      return err(new AbortError());
    }
    if (!isResultLike(result)) {
      return err(new ValidationEngineError('自定义校验器返回了无效 Result', result));
    }
    if (result.ok) {
      return ok(undefined);
    }
    if (result.error instanceof ValidationError || result.error instanceof AbortError) {
      return err(result.error);
    }
    if (result.error instanceof ValidationEngineError) {
      return err(result.error);
    }
    return err(new ValidationEngineError('自定义校验器返回了未知错误类型', result.error));
  } catch (cause: unknown) {
    if (context.signal.aborted) {
      return err(new AbortError('校验已取消', cause));
    }
    return err(new ValidationEngineError('自定义校验器执行失败', cause));
  } finally {
    removeAbortListener?.();
  }
}

/**
 * 按声明顺序验证一个字段，并在首个失败处短路。
 *
 * 内置规则同步完成；custom 规则通过 `runValidator` 支持 Promise。取消被单独标记为
 * `cancelled`，不会制造普通错误文案。规则读取、异步等待和结果归并都在此处完成，
 * 便于 FormApi 保证“最新校验优先”。复杂度为 O(R + A)，R 为规则数，A 为异步校验成本。
 */
export async function validateValue(
  value: unknown,
  rules: readonly ValidationRuleConfig[],
  options: {
    readonly field?: string;
    readonly values?: JsonRecord;
    readonly validators?: ValidatorRegistry;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ValidationResult> {
  // 本函数本身不创建内部取消触发器：直接使用调用方 signal 可避免同步校验结束后
  // 残留 abort listener。FormApi 会为每次运行提供独立 controller。
  const signal = options.signal ?? new AbortController().signal;
  const errors: ValidationError[] = [];

  for (const rule of rules) {
    if (signal.aborted) {
      return { valid: false, errors: [], cancelled: true };
    }
    if (rule.type !== 'custom') {
      const failure = validateBuiltInRule(value, rule, options.field);
      if (failure) {
        errors.push(failure);
        break;
      }
      continue;
    }

    let validator: Validator | undefined;
    try {
      const registry = options.validators;
      validator =
        registry !== undefined && Object.prototype.hasOwnProperty.call(registry, rule.validatorId)
          ? registry[rule.validatorId]
          : undefined;
    } catch (cause: unknown) {
      errors.push(
        new ValidationError(rule.message ?? '读取自定义校验器失败', {
          field: options.field,
          rule: rule.type,
          cause: new ValidationEngineError('读取自定义校验器失败', cause),
        }),
      );
      break;
    }
    if (!validator) {
      errors.push(
        new ValidationError(rule.message ?? `未找到校验器：${rule.validatorId}`, {
          field: options.field,
          rule: rule.type,
        }),
      );
      break;
    }
    const result = await runValidator(validator, value, {
      field: options.field ?? '',
      values: options.values ?? {},
      signal,
    });
    if (!result.ok) {
      if (result.error instanceof AbortError) {
        return { valid: false, errors: [], cancelled: true };
      }
      if (result.error instanceof ValidationError) {
        errors.push(
          rule.message && result.error.message !== rule.message
            ? new ValidationError(rule.message, {
                field: options.field,
                rule: rule.type,
                cause: result.error,
              })
            : result.error,
        );
      } else {
        // runValidator 已将未知返回值统一封装为 ValidationEngineError；到达这里时
        // error 始终是领域 Error，直接读取 message 可避免不必要的不可达分支。
        const message = result.error.message;
        errors.push(
          new ValidationError(rule.message ?? message, {
            field: options.field,
            rule: rule.type,
            cause: result.error,
          }),
        );
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 只执行同步内置规则，不创建 Promise。
 * 适合提交前的快速预检或测试；custom 规则会被跳过，必须调用 `validateValue` 才能执行。
 */
export function validateValueSync(
  value: unknown,
  rules: readonly ValidationRuleConfig[],
  field?: string,
): Result<void, ValidationError> {
  for (const rule of rules) {
    if (rule.type === 'custom') {
      continue;
    }
    const failure = validateBuiltInRule(value, rule, field);
    if (failure) {
      return err(failure);
    }
  }
  return ok(undefined);
}

/**
 * 合并外部和内部取消信号。
 * 任一 signal 触发都会触发返回 signal；`once` 监听器确保单次释放，且已取消的 signal
 * 会立即传播 reason。函数只创建一个中间 controller，时间/空间复杂度 O(1)。
 */
export function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  let internalListener: (() => void) | undefined;
  let externalListener: (() => void) | undefined;
  // 任一来源终止后立即移除另一来源的监听器，避免一个长生命周期 signal
  // 持有已完成任务的闭包。来源尚未终止时，监听器会持续到任务真正结束。
  const cleanup = (): void => {
    if (internalListener !== undefined) {
      internal.removeEventListener('abort', internalListener);
      internalListener = undefined;
    }
    if (external !== undefined && externalListener !== undefined) {
      external.removeEventListener('abort', externalListener);
      externalListener = undefined;
    }
  };
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
    cleanup();
  };
  if (internal.aborted) {
    abortFrom(internal);
  } else {
    internalListener = () => abortFrom(internal);
    internal.addEventListener('abort', internalListener, { once: true });
  }
  if (!controller.signal.aborted && external !== undefined) {
    if (external.aborted) {
      abortFrom(external);
    } else {
      externalListener = () => abortFrom(external);
      external.addEventListener('abort', externalListener, { once: true });
    }
  }
  return controller.signal;
}

/**
 * 创建一个跟随外部 signal 的 AbortController。
 * FormApi 用它隔离“同字段新校验”“提交”“重置/销毁”等生命周期；外部取消只影响
 * 当前 controller，不会修改调用方的 signal。调用方负责在任务结束后移除监听器。
 */
export function createCombinedController(external?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!external) {
    return controller;
  }
  let abort: (() => void) | undefined;
  const cleanup = (): void => {
    if (abort !== undefined) {
      external.removeEventListener('abort', abort);
      abort = undefined;
    }
  };
  abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(external.reason);
    }
    cleanup();
  };
  // 调用方主动终止内部 controller 时也要解除外部 signal 监听。
  controller.signal.addEventListener('abort', cleanup, { once: true });
  if (external.aborted) {
    abort();
  } else {
    external.addEventListener('abort', abort, { once: true });
  }
  return controller;
}

/**
 * 成功分支。
 *
 * `ok` 是判别字段，调用方可以通过 `result.ok` 在不使用类型断言的情况下
 * 安全地取得 `value`。该结构保持不可变，适合在多个 workspace 包之间传递。
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * 失败分支。
 *
 * 错误值不会被吞掉或转换成字符串；上层可以保留完整的领域错误类型，
 * 从而在 UI、日志和提交边界分别处理错误。
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * 公共 API 使用的判别联合。
 *
 * 预期错误（例如 Schema 解析、组件注册和校验失败）通过此类型返回，
 * 避免把可恢复错误当作异常抛出；真正需要中断控制流的依赖环仍由上层按约定抛出。
 */
export type Result<T, E> = Ok<T> | Err<E>;

/** 创建成功结果。时间复杂度 O(1)，不会复制传入值。 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** 创建失败结果。时间复杂度 O(1)，错误对象按原引用保留。 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** 类型守卫：判断结果是否成功。时间复杂度 O(1)。 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** 类型守卫：判断结果是否失败。时间复杂度 O(1)。 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * 只转换成功值，失败分支原样透传。
 * 这是函数式组合的基础操作；`mapper` 仅在 `ok === true` 时执行。
 * 时间复杂度 O(1)（不含 `mapper` 自身复杂度）。
 */
export function map<T, U, E>(result: Result<T, E>, mapper: (value: T) => U): Result<U, E> {
  return result.ok ? ok(mapper(result.value)) : result;
}

/**
 * 串联另一个返回 `Result` 的操作。
 * 当前一步失败时短路，不会调用 `mapper`，因此可用来构造无异常的错误传播链。
 * 时间复杂度 O(1)（不含 `mapper` 自身复杂度）。
 */
export function flatMap<T, U, E, F>(
  result: Result<T, E>,
  mapper: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? mapper(result.value) : result;
}

/**
 * 取得成功值；失败时使用备用值或惰性备用函数。
 * 惰性函数只会在失败分支调用一次，适合备用值计算成本较高的场景。
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T | ((error: E) => T)): T {
  if (result.ok) {
    return result.value;
  }
  return typeof fallback === 'function' ? (fallback as (error: E) => T)(result.error) : fallback;
}

/**
 * 将可能抛异常的同步函数封装成 `Result`。
 * `catch` 使用 `unknown` 保留未知异常，再由 `mapError` 转换成调用方需要的领域错误。
 */
export function tryCatch<T, E>(operation: () => T, mapError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(operation());
  } catch (cause: unknown) {
    return err(mapError(cause));
  }
}

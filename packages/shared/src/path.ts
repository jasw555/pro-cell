/**
 * 将点号路径拆分为非空片段。
 *
 * 路径是引擎内部统一的字段标识格式（例如 `user.phone`）。空片段会被移除，
 * 让用户输入的多余点号不会产生隐式空字段；调用方如需严格校验应在更外层完成。
 * 时间复杂度 O(P)，P 为路径字符串长度。
 */
export function splitPath(path: string): readonly string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

/**
 * 判断是否为可能触发原型污染的对象键。
 * Schema 值和表单值会经过本模块读写，因此拒绝这三个特殊片段可以阻断
 * `__proto__`、`constructor` 和 `prototype` 形式的原型链访问。
 */
function isUnsafeSegment(segment: string): boolean {
  return segment === '__proto__' || segment === 'prototype' || segment === 'constructor';
}

/**
 * 读取路径片段，同时区分“真实缺失属性”和“代理对象的动态读取”。
 * 普通对象的继承属性（尤其是原型上的 getter）不能被当作表单值读取；但如果对象是
 * Proxy 且目标没有该继承属性，仍执行一次 Reflect.get，让读取异常由表达式层转换为
 * `ExpressionError`。原型链检查平均 O(H)，H 为原型链深度。
 */
function readSegment(current: object, segment: string): unknown {
  if (Object.prototype.hasOwnProperty.call(current, segment)) {
    return Reflect.get(current, segment);
  }
  let prototype = Object.getPrototypeOf(current);
  while (prototype !== null) {
    if (Object.prototype.hasOwnProperty.call(prototype, segment)) {
      return undefined;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return Reflect.get(current, segment);
}

/**
 * 按点号路径读取扁平或嵌套记录。
 *
 * 先检查完整键再按片段遍历，兼容表单状态中同时存在 `user.phone` 与嵌套
 * `user.phone` 的场景；遍历只读取自有属性，避免意外读到原型成员。若路径不安全、
 * 中间值不是普通对象或字段不存在，则返回 `undefined`。时间复杂度 O(S)，S 为片段数。
 */
export function getPathValue(values: Readonly<Record<string, unknown>>, path: string): unknown {
  const segments = splitPath(path);
  if (segments.some(isUnsafeSegment)) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(values, path)) {
    return values[path];
  }
  // 空路径没有可遍历的片段；不存在同名自有键时应视为缺失，不能把整份 values
  // 意外返回给表达式或校验器。
  if (segments.length === 0) {
    return undefined;
  }
  let current: unknown = values;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    // 继承成员会在 readSegment 中被忽略；自有 getter 或 Proxy 的异常交给表达式层处理。
    const next = readSegment(current, segment);
    current = next;
  }
  return current;
}

/**
 * 返回设置指定路径后的新记录，不修改调用方对象。
 * 中间对象按需创建，且每一层只做一次浅复制；因此空间和时间复杂度均为 O(S)，
 * S 为路径片段数。危险片段会被忽略并返回原记录的浅副本。
 */
export function setPathValue(
  values: Readonly<Record<string, unknown>>,
  path: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const segments = splitPath(path);
  if (segments.some(isUnsafeSegment)) {
    return { ...values };
  }
  // 与 getPathValue 保持同一优先级：如果调用方已经使用扁平键保存该路径，
  // 必须直接更新扁平键，否则新建的嵌套对象会被读取函数忽略，造成“写入成功但读回旧值”。
  if (Object.prototype.hasOwnProperty.call(values, path)) {
    return { ...values, [path]: value };
  }
  if (segments.length <= 1) {
    const key = segments[0] ?? path;
    return { ...values, [key]: value };
  }
  const head = segments[0] ?? path;
  const tail = segments.slice(1);
  const child = getPathValue(values, head);
  const nested = setPathValue(
    typeof child === 'object' && child !== null && !Array.isArray(child)
      ? (child as Readonly<Record<string, unknown>>)
      : {},
    tail.join('.'),
    value,
  );
  return { ...values, [head]: nested };
}

/**
 * 规范化字段路径，移除空片段并保留稳定的点号分隔形式。
 * 该函数只做字符串转换，不访问值对象；时间复杂度 O(P)。
 */
export function normalizePath(path: string): string {
  return splitPath(path).join('.');
}

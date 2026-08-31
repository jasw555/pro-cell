import { err, ok, type Result } from '@jasw/pro-cell-shared';
import { ExpressionError } from '@jasw/pro-cell-shared';
import type { CompiledExpression, JsonRecord } from '@jasw/pro-cell-shared';
import { getPathValue } from '@jasw/pro-cell-shared';

/**
 * `$deps` 安全表达式模块。
 *
 * DSL 只保留联动条件需要的语法，不把用户输入交给 JavaScript 解释器：
 * 词法分析 -> 递归下降语法分析 -> AST 求值三步均为显式代码，因此不存在 `eval`
 * 或 `new Function` 注入面。编译产物可重复使用，并同时携带依赖字段列表。
 */

const unsafePathSegments = new Set(['__proto__', 'prototype', 'constructor']);
const maxExpressionLength = 4_096;
const maxExpressionDepth = 64;

function isPathStartChar(value: string): boolean {
  return /[\p{L}_$]/u.test(value);
}

function isPathSegmentChar(value: string): boolean {
  return /[\p{L}\p{N}_$-]/u.test(value);
}

/** 词法分析器能够识别的 token 种类。顺序与语法优先级无关。 */
type TokenKind =
  | 'path'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'null'
  | 'eq'
  | 'neq'
  | 'and'
  | 'or'
  | 'not'
  | 'left'
  | 'right'
  | 'eof';

/** 不可变 token；position 用于把语法错误定位到原始字符串。 */
interface Token {
  readonly kind: TokenKind;
  readonly value?: string | number | boolean | null;
  readonly position: number;
}

/** AST 字面量节点。 */
interface LiteralNode {
  readonly type: 'literal';
  readonly value: unknown;
}

/** AST 字段路径节点。 */
interface PathNode {
  readonly type: 'path';
  readonly path: string;
}

/** AST 一元逻辑节点，目前仅支持 `!`。 */
interface UnaryNode {
  readonly type: 'unary';
  readonly operator: '!';
  readonly operand: ExpressionNode;
}

/** AST 二元逻辑/严格相等节点。 */
interface BinaryNode {
  readonly type: 'binary';
  readonly operator: '===' | '!==' | '&&' | '||';
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}

/** 安全 DSL 的完整 AST 联合。 */
type ExpressionNode = LiteralNode | PathNode | UnaryNode | BinaryNode;

/** 去掉可选的 `{{ }}` 外壳，不改变内部表达式文本。 */
function unwrapTemplate(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

/**
 * 将表达式源码切分成 token。
 * 词法扫描只向前移动 position 一次，因此时间复杂度 O(L)，L 为源码长度；
 * 不认识的字符立即返回 ExpressionError，避免宽松解析产生歧义。
 */
class Lexer {
  private position = 0;

  public constructor(private readonly input: string) {}

  /** 扫描完整输入并追加 eof token。 */
  public tokenize(): Result<readonly Token[], ExpressionError> {
    const tokens: Token[] = [];
    while (this.position < this.input.length) {
      const current = this.input.charAt(this.position);
      if (/\s/u.test(current)) {
        this.position += 1;
        continue;
      }
      const position = this.position;
      if (this.input.startsWith('===', position)) {
        tokens.push({ kind: 'eq', position });
        this.position += 3;
        continue;
      }
      if (this.input.startsWith('!==', position)) {
        tokens.push({ kind: 'neq', position });
        this.position += 3;
        continue;
      }
      if (this.input.startsWith('&&', position)) {
        tokens.push({ kind: 'and', position });
        this.position += 2;
        continue;
      }
      if (this.input.startsWith('||', position)) {
        tokens.push({ kind: 'or', position });
        this.position += 2;
        continue;
      }
      if (current === '!') {
        tokens.push({ kind: 'not', position });
        this.position += 1;
        continue;
      }
      if (current === '(') {
        tokens.push({ kind: 'left', position });
        this.position += 1;
        continue;
      }
      if (current === ')') {
        tokens.push({ kind: 'right', position });
        this.position += 1;
        continue;
      }
      if (current === '"' || current === "'") {
        const stringResult = this.readString(current, position);
        if (!stringResult.ok) {
          return stringResult;
        }
        tokens.push(stringResult.value);
        continue;
      }
      if (
        /[0-9-]/u.test(current) ||
        (current === '.' && /[0-9]/u.test(this.input.charAt(this.position + 1)))
      ) {
        const numberResult = this.readNumber(position);
        if (!numberResult.ok) {
          return numberResult;
        }
        tokens.push(numberResult.value);
        continue;
      }
      if (this.input.startsWith('$deps.', position)) {
        const pathResult = this.readPath(position);
        if (!pathResult.ok) {
          return pathResult;
        }
        tokens.push(pathResult.value);
        continue;
      }
      if (/[A-Za-z_]/u.test(current)) {
        const identifier = this.readIdentifier();
        if (identifier === 'true') {
          tokens.push({ kind: 'true', value: true, position });
        } else if (identifier === 'false') {
          tokens.push({ kind: 'false', value: false, position });
        } else if (identifier === 'null') {
          tokens.push({ kind: 'null', value: null, position });
        } else {
          return err(this.error(`不支持的标识符 “${identifier}”`, position));
        }
        continue;
      }
      return err(this.error(`无法识别的字符 “${current}”`, position));
    }
    tokens.push({ kind: 'eof', position: this.position });
    return ok(tokens);
  }

  /** 读取关键字候选；真正的关键字校验在 tokenize 中完成。 */
  private readIdentifier(): string {
    const start = this.position;
    while (
      this.position < this.input.length &&
      /[A-Za-z0-9_$-]/u.test(this.input.charAt(this.position))
    ) {
      this.position += 1;
    }
    return this.input.slice(start, this.position);
  }

  /** 读取 `$deps.foo.bar` 路径，并在词法阶段拒绝危险对象键。 */
  private readPath(position: number): Result<Token, ExpressionError> {
    this.position += '$deps.'.length;
    const start = this.position;
    if (this.position >= this.input.length || !isPathStartChar(this.input.charAt(this.position))) {
      return err(this.error('$deps. 后必须跟字段路径', position));
    }
    while (this.position < this.input.length) {
      const current = this.input.charAt(this.position);
      if (isPathSegmentChar(current)) {
        this.position += 1;
        continue;
      }
      if (current === '.') {
        if (
          this.position + 1 >= this.input.length ||
          !isPathStartChar(this.input.charAt(this.position + 1))
        ) {
          return err(this.error('字段路径中的点号后必须跟标识符', this.position));
        }
        this.position += 1;
        continue;
      }
      break;
    }
    const path = this.input.slice(start, this.position);
    if (path.split('.').some((segment) => unsafePathSegments.has(segment))) {
      return err(this.error('字段路径包含不安全段', position));
    }
    return ok({ kind: 'path', value: path, position });
  }

  /** 读取有限小数/负数；不接受 NaN、Infinity 或孤立负号。 */
  private readNumber(position: number): Result<Token, ExpressionError> {
    const start = this.position;
    if (this.input[this.position] === '-') {
      this.position += 1;
    }
    while (this.position < this.input.length && /[0-9]/u.test(this.input.charAt(this.position))) {
      this.position += 1;
    }
    if (this.input[this.position] === '.') {
      this.position += 1;
      while (this.position < this.input.length && /[0-9]/u.test(this.input.charAt(this.position))) {
        this.position += 1;
      }
    }
    const raw = this.input.slice(start, this.position);
    const value = Number(raw);
    if (!Number.isFinite(value) || raw === '-' || raw === '') {
      return err(this.error(`无效数字 “${raw}”`, position));
    }
    return ok({ kind: 'number', value, position });
  }

  /** 读取单/双引号字符串，仅处理 DSL 明确允许的转义字符。 */
  private readString(quote: string, position: number): Result<Token, ExpressionError> {
    this.position += 1;
    let value = '';
    while (this.position < this.input.length) {
      const current = this.input.charAt(this.position);
      if (current === quote) {
        this.position += 1;
        return ok({ kind: 'string', value, position });
      }
      if (current === '\\') {
        this.position += 1;
        if (this.position >= this.input.length) {
          return err(this.error('字符串转义不完整', position));
        }
        const escaped = this.input.charAt(this.position);
        const escapes: Readonly<Record<string, string>> = {
          n: '\n',
          r: '\r',
          t: '\t',
          '\\': '\\',
          "'": "'",
          '"': '"',
        };
        value += escapes[escaped] ?? escaped;
        this.position += 1;
        continue;
      }
      value += current;
      this.position += 1;
    }
    return err(this.error('字符串缺少结束引号', position));
  }

  /** 统一生成带源码和位置的表达式错误。 */
  private error(message: string, position: number): ExpressionError {
    return new ExpressionError(this.input, message, position);
  }
}

/**
 * 按运算符优先级构建 AST 的递归下降解析器。
 * parseOr -> parseAnd -> parseEquality -> parseUnary -> parsePrimary 的调用链
 * 编码了优先级；每个 token 最多消费一次，时间复杂度 O(T)，T 为 token 数。
 */
class Parser {
  private cursor = 0;
  private depth = 0;

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  /** 解析一个完整表达式，并拒绝末尾多余 token。 */
  public parse(): Result<ExpressionNode, ExpressionError> {
    const expression = this.parseOr();
    if (!expression.ok) {
      return expression;
    }
    const token = this.peek();
    return token.kind === 'eof'
      ? expression
      : err(new ExpressionError(this.source, '表达式末尾存在多余内容', token.position));
  }

  /** 解析最低优先级的逻辑或。 */
  private parseOr(): Result<ExpressionNode, ExpressionError> {
    let left = this.parseAnd();
    while (left.ok && this.match('or')) {
      const right = this.parseAnd();
      if (!right.ok) {
        return right;
      }
      left = ok({ type: 'binary', operator: '||', left: left.value, right: right.value });
    }
    return left;
  }

  /** 解析逻辑与；高于逻辑或、低于相等比较。 */
  private parseAnd(): Result<ExpressionNode, ExpressionError> {
    let left = this.parseEquality();
    while (left.ok && this.match('and')) {
      const right = this.parseEquality();
      if (!right.ok) {
        return right;
      }
      left = ok({ type: 'binary', operator: '&&', left: left.value, right: right.value });
    }
    return left;
  }

  /** 解析连续的严格相等/不等比较。 */
  private parseEquality(): Result<ExpressionNode, ExpressionError> {
    let left = this.parseUnary();
    while (left.ok) {
      const operator = this.match('eq') ? '===' : this.match('neq') ? '!==' : undefined;
      if (!operator) {
        break;
      }
      const right = this.parseUnary();
      if (!right.ok) {
        return right;
      }
      left = ok({ type: 'binary', operator, left: left.value, right: right.value });
    }
    return left;
  }

  /** 解析可连续嵌套的一元非运算。 */
  private parseUnary(): Result<ExpressionNode, ExpressionError> {
    const token = this.peek();
    if (this.match('not')) {
      const operand = this.parseNested(token.position, () => this.parseUnary());
      return operand.ok ? ok({ type: 'unary', operator: '!', operand: operand.value }) : operand;
    }
    return this.parsePrimary();
  }

  /** 解析括号、字段路径和字面量等基本项。 */
  private parsePrimary(): Result<ExpressionNode, ExpressionError> {
    const token = this.peek();
    if (this.match('left')) {
      const expression = this.parseNested(token.position, () => this.parseOr());
      if (!expression.ok) {
        return expression;
      }
      if (!this.match('right')) {
        return err(new ExpressionError(this.source, '缺少右括号', this.peek().position));
      }
      return expression;
    }
    if (token.kind === 'path') {
      this.cursor += 1;
      return ok({ type: 'path', path: String(token.value) });
    }
    if (
      token.kind === 'string' ||
      token.kind === 'number' ||
      token.kind === 'true' ||
      token.kind === 'false' ||
      token.kind === 'null'
    ) {
      this.cursor += 1;
      return ok({ type: 'literal', value: token.value });
    }
    return err(new ExpressionError(this.source, '此处需要字段路径或字面量', token.position));
  }

  /** 限制括号与一元运算的组合嵌套，避免递归下降解析耗尽调用栈。 */
  private parseNested(
    position: number,
    parse: () => Result<ExpressionNode, ExpressionError>,
  ): Result<ExpressionNode, ExpressionError> {
    if (this.depth >= maxExpressionDepth) {
      return err(
        new ExpressionError(
          this.source,
          `表达式嵌套深度不能超过 ${maxExpressionDepth} 层`,
          position,
        ),
      );
    }
    this.depth += 1;
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  /** 查看当前 token；越界时返回合成 eof，保证解析器不会抛 RangeError。 */
  private peek(): Token {
    return (
      this.tokens[Math.min(this.cursor, this.tokens.length - 1)] ?? {
        kind: 'eof',
        position: this.source.length,
      }
    );
  }

  /** 若当前 token 类型匹配则消费它并返回 true。 */
  private match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) {
      return false;
    }
    this.cursor += 1;
    return true;
  }
}

/**
 * 在只读值快照上解释 AST。
 * `&&` 与 `||` 使用布尔短路语义，但始终返回 boolean；其余运算仅做严格比较。
 * 递归深度由表达式括号/运算符深度决定，正常 DSL 输入下为 O(L) 时间、O(L) 栈空间。
 */
function evaluateNode(node: ExpressionNode, values: JsonRecord): unknown {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'path':
      return getPathValue(values, node.path);
    case 'unary':
      return !evaluateNode(node.operand, values);
    case 'binary': {
      if (node.operator === '&&') {
        return (
          Boolean(evaluateNode(node.left, values)) && Boolean(evaluateNode(node.right, values))
        );
      }
      if (node.operator === '||') {
        return (
          Boolean(evaluateNode(node.left, values)) || Boolean(evaluateNode(node.right, values))
        );
      }
      const left = evaluateNode(node.left, values);
      const right = evaluateNode(node.right, values);
      return node.operator === '===' ? left === right : left !== right;
    }
  }
}

/** 深度优先收集 AST 中的路径节点；Set 去重且保留首次出现顺序。 */
function collectDependencies(node: ExpressionNode, output: Set<string>): void {
  switch (node.type) {
    case 'path':
      output.add(node.path);
      return;
    case 'literal':
      return;
    case 'unary':
      collectDependencies(node.operand, output);
      return;
    case 'binary':
      collectDependencies(node.left, output);
      collectDependencies(node.right, output);
      return;
  }
}

/**
 * 编译安全 `$deps` 表达式 DSL，不执行任意 JavaScript。
 * 词法分析、递归下降解析和依赖收集均为 O(L)，L 为表达式长度；返回的 evaluate
 * 是纯函数，可在多个联动事务中重复调用。编译失败通过 ExpressionError 返回。
 */
export function compileExpression<T = unknown>(
  source: string,
): Result<CompiledExpression<T>, ExpressionError> {
  let errorSource = '';
  try {
    errorSource = typeof source === 'string' ? source : String(source);
    if (typeof source !== 'string') {
      return err(new ExpressionError(errorSource, '表达式必须是字符串', 0));
    }
    if (source.length > maxExpressionLength) {
      return err(
        new ExpressionError(
          source,
          `表达式长度不能超过 ${maxExpressionLength} 个字符`,
          maxExpressionLength,
        ),
      );
    }
    const expression = unwrapTemplate(source);
    if (expression.length === 0) {
      return err(new ExpressionError(source, '表达式不能为空', 0));
    }
    const tokenResult = new Lexer(expression).tokenize();
    if (!tokenResult.ok) {
      return tokenResult;
    }
    const parsed = new Parser(tokenResult.value, expression).parse();
    if (!parsed.ok) {
      return parsed;
    }
    const dependencies = new Set<string>();
    collectDependencies(parsed.value, dependencies);
    const compiled: CompiledExpression<T> = {
      source,
      deps: [...dependencies],
      evaluate(values: JsonRecord): Result<T, ExpressionError> {
        try {
          return ok(evaluateNode(parsed.value, values) as T);
        } catch (cause: unknown) {
          return err(new ExpressionError(source, '表达式求值失败', undefined, cause));
        }
      },
    };
    return ok(compiled);
  } catch (cause: unknown) {
    return err(new ExpressionError(errorSource, '表达式编译失败', undefined, cause));
  }
}

/** 判断字符串是否完整包裹在 `{{ ... }}` 模板中。时间复杂度 O(L)。 */
export function isExpressionTemplate(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.startsWith('{{') && trimmed.endsWith('}}');
}

/** 求值字面量或完整模板；普通字符串直接按字面量返回。 */
export function evaluateActionValue(
  value: unknown,
  values: JsonRecord,
): Result<unknown, ExpressionError> {
  if (!isExpressionTemplate(value)) {
    return ok(value);
  }
  const compiled = compileExpression(value);
  return compiled.ok ? compiled.value.evaluate(values) : compiled;
}

/** 从动作值提取模板依赖；非模板或非法模板返回空数组。 */
export function actionDependencies(value: unknown): readonly string[] {
  if (!isExpressionTemplate(value)) {
    return [];
  }
  const compiled = compileExpression(value);
  return compiled.ok ? compiled.value.deps : [];
}

/** 为旧版调用方保留的 compileExpression 别名。 */
export const parseExpression = compileExpression;

/** 使用同一安全编译器执行一次性表达式。 */
export function evaluateExpression(
  source: string,
  values: JsonRecord,
): Result<unknown, ExpressionError> {
  const compiled = compileExpression(source);
  return compiled.ok ? compiled.value.evaluate(values) : compiled;
}

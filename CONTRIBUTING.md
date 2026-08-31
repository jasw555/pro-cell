# Contributing to Pro Cell

## 环境

- Node.js 22.13 或更高版本（公开包运行时仍支持 Node.js 20+）
- pnpm 11
- Git

安装依赖：

```bash
pnpm install
```

## 常用命令

```bash
pnpm dev
pnpm check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

上述脚本由 Turbo 编排 `build`、`typecheck`、`lint`、`test` 和 `test:coverage` 任务，
并按照 workspace 依赖图先构建内部包；调试单个任务时也可以使用
`pnpm turbo run test --filter=@jasw/pro-cell-core`。

`packages/shared`、`packages/core` 与 `packages/react` 的
lines/functions/branches/statements 覆盖率必须保持在 92% 以上。聚合包另有导出冒烟测试，
示例应用通过类型检查和生产构建验收。新增组件注册、解析器、表达式、依赖追踪、联动逻辑或
校验规则时，需要同步添加边界测试。

## 代码约定

- TypeScript strict mode，禁止 `any`。
- 优先纯函数、不可变数据和组合式 API。
- 公共接口和复杂算法必须使用中文 JSDoc，注明设计意图与时间复杂度。
- 异步接口必须接受可选 `AbortSignal`，并正确处理取消和过期结果。
- 预期错误返回 `Result<T, E>`；捕获未知异常时使用 `unknown` 并封装领域错误。
- Schema 输入不可被库内部修改。
- 注释优先解释设计原因、约束和复杂度，不重复翻译代码本身。

## Commit 规范

提交信息遵循 Conventional Commits，例如：

```text
feat(core): add dependency cycle detection
fix(react): discard stale validation result
docs: explain safe expression grammar
```

Husky 会在提交前运行 lint-staged，提交消息会由 commitlint 校验。

## Pull Request

请在 PR 描述中说明：

1. 变更的包和公共 API。
2. 新增或修改的测试场景。
3. `pnpm lint`、`pnpm typecheck`、`pnpm test:coverage` 和 `pnpm build` 结果。
4. 是否涉及 Schema 协议或错误码兼容性。

GitHub CI 会在 push 和 pull request 时重复执行格式、lint、类型、覆盖率、构建、打包与导入检查。

# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并使用语义化版本。

## [Unreleased]

## [0.1.0] - 2026-08-31

### Added

- 初始化 pnpm + Turborepo Monorepo。
- 增加 `$comp` Schema 解析、递归 children 和 WeakMap 缓存。
- 增加安全表达式 DSL 与 DependencyTracker 循环依赖检测。
- 增加 React 19、Zustand、antd 5 渲染层。
- 增加 required、maxLength、pattern 和可取消异步校验。
- 增加三个复杂联动 JSON 示例。

### Changed

- 完善 npm 单包发布配置、MIT License 和 GitHub CI。
- 增加公开入口冒烟测试与真实 tarball 的外部安装验收。
- 加强表达式、组件注册与联动事务的运行时边界检查。
- React 渲染器改为字段级订阅，无关字段更新不再触发额外渲染。
- React 包与纯逻辑包统一执行 92% 的四项覆盖率门禁。
- 示例应用拆分 React 与 antd vendor，生产构建不再出现大入口块或循环 chunk 告警。
- 精简根 README 和 npm README 的维护者内容，将完整发布流程移至 `RELEASING.md`。

### Fixed

- 深层或超长表达式现在返回 `ExpressionError`，不再向调用方泄漏 `RangeError`。
- `maxTransactionDepth` 改为按因果链深度计算，避免把宽扇出联动误判为运行时循环。
- 自定义组件注册表在渲染期间保持只读，同名自定义组件会稳定覆盖内置组件。
- 任意字段值变化都会使旧的异步校验上下文失效，避免跨字段校验写回过期结果。
- `reset` 输入读取失败时不再提前取消已有任务，快照订阅异常也会封装为领域错误。
- 修复 React 子路径入口与外部 `react` 类型模块同名时的声明聚合失败。
- CI 与 pnpm 11 的运行时要求统一为 Node.js 22.13，并升级 GitHub Actions 到 Node 24 运行时版本。
- 修复 README 架构图中未加引号的特殊字符和不兼容换行，确保 GitHub Mermaid 可以正常渲染。

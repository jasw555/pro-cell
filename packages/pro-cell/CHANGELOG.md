# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，并使用语义化版本。

## [Unreleased]

### Changed

- 补充字段样式、作用域 CSS、antd 主题、自定义布局及样式边界文档。

### Fixed

- 架构图改用静态 SVG，避免不支持 Mermaid 的 README 页面显示源码。

## [0.1.0] - 2026-08-31

### Added

- 初始化 React 19 `$comp` Schema 表单/表格引擎。
- 提供单包根入口及 `/core`、`/react`、`/shared` 子路径导出，均含 ESM/CJS 和 TypeScript 声明。
- 增加安全表达式 DSL、`DependencyTracker` 拓扑循环检测和串行联动队列。
- 增加 antd `Input`、`Select`、`Switch`、`Table`、`Fragment` 内置组件与可扩展注册表。
- 增加 required、maxLength、pattern 和支持 AbortController 的异步校验。

### Changed

- 完善 npm 发布元数据、MIT License 和构建前检查。
- 增加公开入口冒烟测试与真实 tarball 的外部安装验收。
- 加强表达式、组件注册与联动事务的运行时边界检查。
- React 渲染器改为字段级订阅，无关字段更新不再触发额外渲染。
- React 包与纯逻辑包统一执行 92% 的四项覆盖率门禁。
- npm README 聚焦安装与使用，维护者发布流程移至仓库文档。

### Fixed

- 深层或超长表达式现在返回 `ExpressionError`，不再向调用方泄漏 `RangeError`。
- `maxTransactionDepth` 改为按因果链深度计算，避免把宽扇出联动误判为运行时循环。
- 自定义组件注册表在渲染期间保持只读，同名自定义组件会稳定覆盖内置组件。
- 任意字段值变化都会使旧的异步校验上下文失效，避免跨字段校验写回过期结果。
- `reset` 输入读取失败时不再提前取消已有任务，快照订阅异常也会封装为领域错误。
- 修复 React 子路径入口与外部 `react` 类型模块同名时的声明聚合失败。
- 修复 npm README 架构图的 Mermaid 标签与换行语法。

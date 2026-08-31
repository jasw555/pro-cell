# 发布 @jasw/pro-cell

这份文档只面向项目维护者。使用方式和 API 请看 [README.md](./README.md)，参与开发请看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 发布边界

- npm 只发布 `@jasw/pro-cell`；
- `core`、`react`、`shared` 和 `examples` 都是私有 workspace；
- `/core`、`/react`、`/shared` 是同一个 tarball 的子路径，不是独立包；
- 当前没有自动发布流水线，由维护者手动发布。

## 发布前提

- Node.js 22.13 或更高版本，pnpm 11；
- npm 登录账号为 `jasw`，并能发布 `@jasw` scope；
- 当前分支为 `main`，工作区干净；
- GitHub CI 已通过。

公开版本以 `packages/pro-cell/package.json` 的 `version` 为准。

## 1. 准备版本

1. 更新 `packages/pro-cell/package.json` 中的版本号。
2. 整理根目录和 `packages/pro-cell` 下的 `CHANGELOG.md`：把本次内容从 `Unreleased` 移入带日期的版本章节，并重新保留空的 `Unreleased`。
3. 检查 README 中显式写出的版本和兼容性，确保没有落后于源码。

版本号遵循语义化版本：

- patch：兼容的缺陷修复；
- minor：向后兼容的新功能；
- major：破坏性变更。

## 2. 本地验收

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
pnpm audit --prod
```

`pnpm check` 会执行格式、lint、类型、覆盖率和构建。`pnpm pack:check` 用于确认 tarball 只包含发布所需文件。

GitHub CI 还会把真实 tarball 安装到 workspace 外的临时项目，验证根入口及 `/core`、`/react`、`/shared` 的 ESM、CommonJS 和 TypeScript 用法，并检查产物中没有私有 workspace 引用。

## 3. 提交版本

将 `<version>` 替换为实际版本，例如 `0.1.0`：

```bash
git add packages/pro-cell/package.json CHANGELOG.md packages/pro-cell/CHANGELOG.md README.md packages/pro-cell/README.md
git commit -m "chore(release): v<version>"
git push origin main
```

等待 `main` 上的 CI 通过后再继续。不要从有未提交修改的工作区发布。

## 4. 发布 npm

```bash
pnpm whoami
pnpm --filter @jasw/pro-cell publish --access public
```

`whoami` 应返回 `jasw`。如果 npm 账号开启了双因素认证，发布时按提示输入 OTP。`prepublishOnly` 会再次执行完整门禁，`prepack` 会重建公开包及内部依赖。

发布完成后检查 registry：

```bash
npm view @jasw/pro-cell version
npm view @jasw/pro-cell dist-tags
```

## 5. 添加 Git tag

确认 npm 已出现新版本后，再给同一提交添加标签：

```bash
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

随后可以在 GitHub 根据该 tag 创建 Release，并从 CHANGELOG 摘取本次变更。

## 发布异常

- npm 版本号不可重复使用。重试前先用 `npm view @jasw/pro-cell versions --json` 确认是否已经发布成功。
- 已发布版本出现问题时，优先发布修复版本；不要把 `unpublish` 当作常规回滚手段。
- 不要在项目目录执行会把登录凭据写入 `.npmrc` 的命令，仓库内的 `.npmrc` 只能保存普通 pnpm 配置。

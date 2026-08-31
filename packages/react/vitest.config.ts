import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * React 包的测试入口统一加载 antd v5 的 React 19 兼容补丁。
 * 单独配置文件不会改变业务构建；Vitest 会把 setup 文件注入每个测试文件，
 * 因而新增 renderer 测试时无需重复书写全局补丁 import。
 */
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('./test/setup.ts', import.meta.url))],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      // index.ts 仅负责公开重导出，types.ts 在运行时没有可执行逻辑；门禁聚焦实际实现。
      include: ['src/builtins.ts', 'src/formStore.ts', 'src/registry.ts', 'src/renderer.tsx'],
      thresholds: {
        lines: 92,
        functions: 92,
        branches: 92,
        statements: 92,
      },
    },
  },
});

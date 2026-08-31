import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src'],
      outDir: 'dist',
      rollupTypes: true,
      bundledPackages: ['@jasw/pro-cell-shared', '@jasw/pro-cell-core', '@jasw/pro-cell-react'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    // 发布包不携带包含 workspace 源码路径的 source map，避免消费者看到或
    // 误解析私有实现包；运行时代码和声明已在各入口内联/重写。
    sourcemap: false,
    lib: {
      entry: {
        index: resolve(packageRoot, 'src/index.ts'),
        core: resolve(packageRoot, 'src/core.ts'),
        // 源文件不直接命名为 react.ts，避免 API Extractor 在多入口声明聚合时
        // 把外部 `react` 类型模块误认成当前入口；对外文件名仍由入口键固定为 react。
        react: resolve(packageRoot, 'src/react-entry.ts'),
        shared: resolve(packageRoot, 'src/shared.ts'),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // React、antd 与 Zustand 均由消费者提供；同时匹配 Zustand 子路径，
      // 避免把 zustand/vanilla 重复打进发布包。
      external: (id) =>
        id === 'antd' ||
        /^react(?:\/|$)/u.test(id) ||
        /^react-dom(?:\/|$)/u.test(id) ||
        /^zustand(?:\/|$)/u.test(id),
    },
  },
});

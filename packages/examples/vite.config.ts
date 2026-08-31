import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 示例同时展示 Form、Select 和 Table，若全部留在入口块会超过 Vite 的 500 kB 提示线。
 * 这里把 React 与 antd 生态拆成两个稳定的 vendor 块。antd 和 rc 系列包之间
 * 存在共享运行时代码，继续硬拆会形成循环 chunk；公开库本身仍把
 * React/antd/Zustand 作为 peer external。
 */
function vendorChunk(id: string): string | undefined {
  const path = id.replaceAll('\\', '/');
  if (!path.includes('/node_modules/')) return undefined;
  if (
    path.includes('/node_modules/react/') ||
    path.includes('/node_modules/react-dom/') ||
    path.includes('/node_modules/scheduler/')
  ) {
    return 'react-vendor';
  }
  if (
    path.includes('/node_modules/antd/') ||
    path.includes('/node_modules/@ant-design/') ||
    path.includes('/node_modules/@rc-component/') ||
    /\/node_modules\/rc-[^/]+\//u.test(path)
  ) {
    return 'antd-vendor';
  }
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // 示例一次加载 Form、Select、Switch 与 Table；antd vendor 的 gzip 体积约 240 kB。
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
});

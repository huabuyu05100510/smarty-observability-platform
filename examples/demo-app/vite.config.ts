import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 构建产出 sourcemap（供 backend /api/sourcemaps/upload 后还原源码）
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    outDir: 'dist',
  },
  server: { port: 5179, host: '127.0.0.1' },
});

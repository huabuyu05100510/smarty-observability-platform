import { defineConfig } from 'tsup';

// 自包含浏览器 bundle：把 @monit/contracts/trace/fingerprint 全部内联进单文件，
// 便于 vendor 进任意项目（零 workspace 依赖解析）。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist-bundle',
  noExternal: [/^@monit\//],
  dts: false,
  splitting: false,
  treeshake: true,
  clean: true,
});
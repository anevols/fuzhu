import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: true,
  external: ['node:sqlite'],
  // 工作区包直接以 TS 源码发布，必须打进产物
  noExternal: ['@tunnel/protocol'],
});

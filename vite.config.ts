import { defineConfig } from 'vitest/config';

// `base` is relative so the build works both locally and on GitHub Pages (served from /<repo>/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
  },
});

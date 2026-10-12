import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
export default defineConfig({
  root: import.meta.dirname,
  plugins: [pluginReact()],
  source: { entry: { index: './src/main.tsx' } },
  html: { title: 'SubHarbor' },
  output: { distPath: { root: '../../dist/web' }, cleanDistPath: true },
  server: {
    port: 3001,
    proxy: { '/api': 'http://127.0.0.1:3000', '/sub': 'http://127.0.0.1:3000' },
  },
});

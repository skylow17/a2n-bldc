import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    // `serialport` est un module natif : il doit rester externe, jamais empaqueté.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});

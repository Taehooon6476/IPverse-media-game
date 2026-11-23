/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Fixed root so `npx vite --config web/vite.config.ts` also works from the repo root.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // Real backend in dev: `server/local_dev.py` listens on 8787.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'jsdom' },
});

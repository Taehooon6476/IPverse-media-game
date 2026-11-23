import { defineConfig } from 'vite';
import base from '../vite.config';

// Local visual QA uses the existing deployment for read-only content and Cognito config.
const studio = 'https://d12ka835iwfpnx.cloudfront.net';
const proxy = { target: studio, changeOrigin: true, secure: true };

export default defineConfig({
  ...base,
  preview: {
    host: '127.0.0.1',
    port: 5201,
    strictPort: true,
    proxy: { '/api': proxy, '/games': proxy, '/config.json': proxy },
  },
});

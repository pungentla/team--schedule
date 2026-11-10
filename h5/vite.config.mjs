import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: Number(process.env.H5_PORT || 8080),
    strictPort: true,
    proxy: {
      '/api': `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 3000}`,
    },
  },
});

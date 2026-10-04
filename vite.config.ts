import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/worldbank': {
        target: 'https://api.worldbank.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worldbank/, '')
      }
    }
  }
});
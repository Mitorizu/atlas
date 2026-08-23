import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: { open: false },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});

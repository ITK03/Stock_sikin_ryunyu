import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps asset/data paths relative so it works on GitHub Pages
// (served from /<repo>/) and locally without changes.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

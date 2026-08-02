import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves project sites from /<repo>/, so assets need that prefix.
// Override with BASE_PATH=/ when using a custom domain or a user.github.io repo.
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/Mint-Voicemail/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});

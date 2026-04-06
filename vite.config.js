import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        login: './login.html',
      },
    },
  },
});

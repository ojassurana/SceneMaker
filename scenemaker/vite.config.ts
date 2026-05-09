import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { sceneEditApiPlugin } from './server/sceneEditApi';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const inheritedOpenAiKey = process.env.OPENAI_API_KEY?.trim();

  process.env.OPENAI_API_KEY =
    inheritedOpenAiKey && inheritedOpenAiKey !== 'undefined' ? inheritedOpenAiKey : env.OPENAI_API_KEY;

  return {
    plugins: [sceneEditApiPlugin(), react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            three: ['three'],
            icons: ['lucide-react'],
          },
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
    },
  };
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const repository = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const owner = process.env.GITHUB_REPOSITORY?.split('/')[0];
  const isUserOrOrgPagesRepo =
    repository && owner ? repository.toLowerCase() === `${owner.toLowerCase()}.github.io` : false;
  const base =
    process.env.GITHUB_ACTIONS === 'true' && repository && !isUserOrOrgPagesRepo
      ? `/${repository}/`
      : '/';
  return {
    base,
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});

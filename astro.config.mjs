// @ts-check
import { defineConfig } from 'astro/config';

/**
 * `/room/:code` can't be prerendered — there are as many codes as there are
 * booths — so production serves the join page for it through a rewrite in
 * vercel.json. The dev server needs the same rule, and it has to live in
 * middleware because there is no file to match against.
 *
 * `astro preview` applies neither rule; it serves `/room` and `/` only.
 */
const roomCodeRewrite = () => ({
  name: 'room-code-rewrite',
  /**
   * @param {import('vite').ViteDevServer} server
   */
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? '';
      const match = /^\/room\/[^/?#]+([?#].*)?$/.exec(url);
      if (match) req.url = `/room${match[1] ?? ''}`;
      next();
    });
  },
});

// https://astro.build/config
export default defineConfig({
  server: {
    host: true,
  },
  vite: {
    build: {
      target: 'es2022',
    },
    plugins: [roomCodeRewrite()],
  },
});

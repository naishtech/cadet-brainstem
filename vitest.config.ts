import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scope the root suite to the backend tests. The Vue SPA (web/) has its own
    // vitest config and must NOT be collected here (it needs @vitejs/plugin-vue).
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'web/**'],
  },
});

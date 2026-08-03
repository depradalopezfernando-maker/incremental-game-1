import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts'],
    // The suite must always run in under 10 seconds — see ROADMAP.md § Testing
    // discipline. If a single test needs longer than this, it is too slow.
    testTimeout: 10_000,
  },
});

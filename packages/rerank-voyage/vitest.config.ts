import { defineConfig } from 'vitest/config';

/**
 * No `@guard` alias, and no `test/guards/` directory beside it: this package carries no
 * Law 1 guard, because Law 1 does not apply to it — it is the one package in the
 * workspace whose whole job is an outbound call. What is guarded about it lives in the
 * two packages that must *not* import it (`packages/core` and `packages/mcp`, whose
 * zero-network guards classify this package name as forbidden), and that is where the
 * mutation runner watches the property go red.
 *
 * The tests here run against a recorded fixture through the injected `fetch`, so this
 * suite reaches the network exactly as often as every other suite in the repository:
 * never.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The packaging guard imports this package's source through `@guard/*`, so the mutation
 * runner (`scripts/mutate.mjs`) can aim it at a *deliberately broken copy* of `src` via
 * `SMELT_GUARD_SRC` and watch it go red — the same arrangement `packages/core` and
 * `packages/mcp` use.
 *
 * There is deliberately **no Law 1 guard** here. Law 1 does not apply to this package:
 * it is the one in the workspace whose whole job is an outbound call. What is guarded
 * about it lives in the two packages that must *not* import it (`packages/core` and
 * `packages/mcp`, whose zero-network guards classify this package name as forbidden),
 * and that is where the mutation runner watches the property go red. What IS this
 * package's own to guard is the tarball: the declarations a consumer compiles against.
 *
 * The tests run through an injected `fetch` against a fixture transcribed from Voyage's
 * published reference — not a recording of a live response — so this suite reaches the
 * network exactly as often as every other suite in the repository: never.
 */
const guardSrc =
  process.env['SMELT_GUARD_SRC'] !== undefined && process.env['SMELT_GUARD_SRC'] !== ''
    ? process.env['SMELT_GUARD_SRC']
    : fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@guard': guardSrc },
  },
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      SMELT_GUARD_SRC: guardSrc,
    },
  },
});

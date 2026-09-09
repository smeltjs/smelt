import { guardAnchor } from '@smelt/guard-kit';

/**
 * This package's guard anchor — the same one call as
 * `packages/core/test/guards/_source.ts` and `packages/mcp`'s. The helpers and their
 * binding live once, in `@smelt/guard-kit`; only this file's `import.meta.url` is this
 * package's own, so a guard reads whatever tree `SMELT_GUARD_SRC` points at and the
 * mutation runner can point it at a deliberately broken copy without touching the
 * working tree.
 */
export const { packageRoot, repoRoot, guardSrcRoot, guardRoot, allSourceFiles, readSource } =
  guardAnchor(import.meta.url);

export { importSpecifiers, stripStringsAndComments } from '@smelt/guard-kit';

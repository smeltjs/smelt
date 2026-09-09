/**
 * The shape of one mutation — the same type the core guards use, re-exported from
 * `@smelt/guard-kit` (`packages/guard-kit/src/mutation.ts`) so this package's guards
 * spell the import `./_mutations.ts` exactly as the core's do, and `scripts/mutate.mjs`
 * keeps finding the one declaration line it anchors on:
 * `export const MUTATIONS: GuardMutation[] = [`.
 */
export type { GuardMutation } from '@smelt/guard-kit';

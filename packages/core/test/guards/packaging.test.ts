import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrieveBatchTool,
  createRetrieveTool,
  RETRIEVE_BATCH_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
} from '@guard/retrieve';
import { MemoryElisionStore } from '@guard/store';

import {
  AMBIENT_GLOBAL_NAMESPACES,
  ambientNamespaceViolations,
  ambientTypeUses,
  deadSourcemapViolations,
  packPackage,
  standaloneTypecheckViolations,
  strictModeViolations,
  type PackedPackage,
} from '@smelt/guard-kit';

import type { GuardMutation } from './_mutations.ts';
import {
  allSourceFiles,
  guardRoot,
  packageRoot,
  readSource,
  stripStringsAndComments,
} from './_source.ts';

/**
 * PACKAGING GUARD — the tarball, audited as a consumer receives it.
 *
 * Every other guard in this directory reads the repository. This one packs the package
 * and reads *that*, because the three defects it exists for were all invisible from
 * inside the repo — each was true of the published bytes and of nothing else:
 *
 *  1. **A declaration that only compiles in someone else's configuration.** The shipped
 *     `.d.ts` named `NodeJS.ReadableStream`. An ambient namespace exists only in a
 *     compilation that pulled `@types/node` into *global* scope, so a consumer building
 *     with `skipLibCheck: false` — and a narrowed `types` array, or simply no
 *     `@types/node` at their own root, which is the ordinary case under pnpm — failed
 *     inside smelt's own `node_modules`, on a file they cannot edit. Naming the node
 *     type by import fixes nothing: TypeScript resolves `node:stream`, and bare
 *     `stream`, through the same globally-included `@types/node`. The fix is to describe
 *     the shape structurally, which is what {@link AnswerStream} now does.
 *
 *     Removing the *namespace* was not the whole defect, and a name-list check could
 *     never have said so: `ambientNamespaceViolations` matches `Namespace.`-dotted
 *     names, so it was structurally blind to a **bare** `@types/node` global. Two
 *     survived it — `RepoReader.read(path): Buffer` and
 *     `assertLocalResource(input: string | URL): URL` — and each was still an error in
 *     smelt's own declarations for exactly the consumer described above. Both are
 *     stated structurally now (`Uint8Array`; `LocalResource`), and the check that keeps
 *     them that way is a compiler rather than a list: `standaloneTypecheckViolations`
 *     builds a scratch consumer around the real tarball with `strict`,
 *     `skipLibCheck: false` and `types: []`, and reports every diagnostic TypeScript
 *     raises inside smelt's own shipped files.
 *
 *     What that check does **not** cover, stated plainly rather than implied away: a
 *     dependency's own declarations. `dist/plan/grammar.d.ts` imports `Language` from
 *     `web-tree-sitter`, whose `.d.ts` names `EmscriptenModule` and asks for
 *     `@types/emscripten` nowhere, so a `types: []` consumer still sees that one error
 *     — from a file in `web-tree-sitter`'s package, not smelt's. It is not smelt's to
 *     fix short of dropping a tree-sitter type from the public surface, and pretending
 *     otherwise is what the first version of this guard did.
 *  2. **Maps that resolve to nothing.** `files` packs `dist`, never `src`, and every
 *     `.js.map` and `.d.ts.map` pointed at `../src/*.ts`. Go-to-definition and stack
 *     traces landed on paths that were never published. The sources are inlined now —
 *     `inlineSources` for the JS maps, `scripts/inline-declaration-map-sources.mjs` for
 *     the declaration maps TypeScript leaves empty — so the maps carry what they need
 *     and cannot drift from it.
 *  3. **A tool schema strict mode will not register.** `smelt_retrieve` advertised no
 *     `additionalProperties: false`, so a consumer using OpenAI structured outputs in
 *     strict mode could not expose the tool at all.
 *
 * **What is guarded where.** The tarball checks are the truth, but a tarball cannot be
 * mutated — so each one is paired with the source-level fact that keeps it true, and
 * that pairing is what `pnpm mutate` proves: reintroduce the ambient namespace in
 * `src`, put `Buffer` back on `RepoReader.read` or `URL` back on
 * `assertLocalResource`, turn `inlineSources` off in `tsconfig.json`, or drop
 * `additionalProperties` from the retrieve schema, and this file goes red.
 */

let packed: PackedPackage;

beforeAll(() => {
  packed = packPackage(packageRoot());
}, 180_000);

afterAll(() => {
  packed?.cleanup();
});

describe('the packed tarball is what a consumer can actually build against', () => {
  it('packs the declarations and maps this guard is about — nothing here is vacuous', () => {
    // Every check below is a filter over `packed.files`; an empty or dist-less tarball
    // would pass all of them while proving nothing. So: the entrypoint's declaration,
    // and enough of both map kinds to know the emit really happened.
    expect(packed.files, 'the tarball has no dist/index.d.ts — was `pnpm build` run?').toContain(
      'dist/index.d.ts',
    );
    const declarations = packed.files.filter((file) => file.endsWith('.d.ts'));
    const jsMaps = packed.files.filter((file) => file.endsWith('.js.map'));
    const declarationMaps = packed.files.filter((file) => file.endsWith('.d.ts.map'));
    expect(declarations.length).toBeGreaterThan(20);
    expect(jsMaps.length).toBeGreaterThan(20);
    expect(declarationMaps.length).toBeGreaterThan(20);
  });

  it('ships no declaration that names an ambient global namespace', () => {
    expect(ambientNamespaceViolations(packed).join('\n')).toBe('');
  });

  it('typechecks on its own under strict, skipLibCheck: false, types: []', () => {
    expect(
      standaloneTypecheckViolations(packed, {
        tsc: join(packageRoot(), 'node_modules', '.bin', 'tsc'),
        packageDir: packageRoot(),
      }).join('\n'),
    ).toBe('');
  }, 180_000);

  it('ships no sourcemap that resolves to a file it did not pack', () => {
    expect(deadSourcemapViolations(packed).join('\n')).toBe('');
  });
});

describe('the source facts that keep the tarball buildable', () => {
  it('no smelt module names an ambient global namespace in code', () => {
    // The source-level half of the tarball's first rule, and the half a mutation can
    // break. Comments are stripped: the doc comment on `AnswerStream` explains why
    // `NodeJS.ReadableStream` is not used, and must stay able to say so.
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const code = stripStringsAndComments(readSource(file));
      for (const namespace of AMBIENT_GLOBAL_NAMESPACES) {
        if (new RegExp(`\\b${namespace}\\s*\\.`).test(code)) {
          offenders.push(`${file} names \`${namespace}\``);
        }
      }
    }
    expect(
      offenders.join('\n'),
      'an ambient namespace in a type position reaches the shipped .d.ts, where it ' +
        'compiles only in a consumer that globally included those types. Describe the ' +
        'shape structurally instead.',
    ).toBe('');
    // Non-vacuity: the scan must have found real source to scan.
    expect(allSourceFiles().length).toBeGreaterThan(20);
  });

  it('no emitted declaration uses a types-package global as a type', () => {
    // The mutatable pairing for the tarball typecheck above.
    // `standaloneTypecheckViolations` is the rule — it asks a compiler and therefore
    // knows names nobody listed — but a tarball cannot be mutated, and `dist` can:
    // put `Buffer` back on `RepoReader.read` or `URL` back on `assertLocalResource`
    // and this goes red.
    //
    // It reads the *declarations*, not `src`, and that is the whole reason it is
    // precise. `const pieces: Buffer[]` inside a function body and a non-exported
    // `function toUrl(...): URL` are both fine — they are compiled away, and smelt's
    // implementation is full of them. Only what TypeScript copies into a `.d.ts`
    // reaches a consumer who has nothing to resolve the name against.
    const dist = join(guardRoot(), 'dist');
    const declarations = allSourceFiles(dist).filter((file) => file.endsWith('.d.ts'));
    expect(
      declarations.length,
      `no declarations under ${dist} — was \`pnpm build\` run?`,
    ).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of declarations) {
      const used = ambientTypeUses(stripStringsAndComments(readSource(file, dist)));
      for (const name of used) offenders.push(`dist/${file} uses \`${name}\` as a type`);
    }
    expect(
      offenders.join('\n'),
      'a types-package global in a type position reaches the shipped .d.ts, where it ' +
        'resolves only for a consumer who happened to install and globally include ' +
        'those types. State the shape structurally instead — `Uint8Array` for bytes, ' +
        'an interface naming the members actually read for a URL.',
    ).toBe('');
  });

  it('tsconfig.json inlines sources into the emitted JavaScript maps', () => {
    // The declaration maps are filled by `scripts/inline-declaration-map-sources.mjs`,
    // which deliberately touches only `*.d.ts.map` — TypeScript's own `inlineSources`
    // is what covers `*.js.map`, and if it were dropped the script must not quietly
    // paper over it. This is that check.
    const path = join(guardRoot(), 'tsconfig.json');
    const config = JSON.parse(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { compilerOptions?: Record<string, unknown> };
    expect(
      config.compilerOptions?.['inlineSources'],
      `${path}: without inlineSources the emitted .js.map files name ../src/*.ts, a ` +
        `path "files" never packs — a dead map on every consumer's machine.`,
    ).toBe(true);
  });
});

describe(`the ${RETRIEVE_TOOL_NAME} schema is registrable under strict structured outputs`, () => {
  const tool = createRetrieveTool(new MemoryElisionStore());

  it('states additionalProperties: false and requires every property', () => {
    expect(strictModeViolations(tool.inputSchema, RETRIEVE_TOOL_NAME).join('\n')).toBe('');
  });

  it('describes the same shape it always did — this is precision, not a new contract', () => {
    // The wire-surface promise covers the tool's *name* and its *behaviour*: hash in,
    // exact bytes out. `hash` was already the only key `invoke` reads and already the
    // only key `required` named; an extra key was already ignored. Saying so in the
    // schema accepts exactly the same call it always accepted.
    expect(tool.name).toBe('smelt_retrieve');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['hash']);
    expect(tool.inputSchema.required).toEqual(['hash']);
    expect(tool.inputSchema.properties.hash.type).toBe('string');
  });
});

describe(`the ${RETRIEVE_BATCH_TOOL_NAME} schema is registrable under strict structured outputs`, () => {
  const tool = createRetrieveBatchTool(new MemoryElisionStore());

  it('states additionalProperties: false and requires every property', () => {
    expect(strictModeViolations(tool.inputSchema, RETRIEVE_BATCH_TOOL_NAME).join('\n')).toBe('');
  });

  it('is a sibling of the frozen tool, not a rename of it', () => {
    // The wire-surface promise covers `smelt_retrieve`'s name and behaviour. The batch
    // tool is additive: a new name, an array where the other takes one string, and the
    // frozen tool untouched beside it. A batch tool that *replaced* the single one
    // would break every marker's `retrieve("hash")` at once.
    expect(tool.name).toBe('smelt_retrieve_batch');
    expect(createRetrieveTool(new MemoryElisionStore()).name).toBe('smelt_retrieve');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['hashes']);
    expect(tool.inputSchema.required).toEqual(['hashes']);
  });
});

export const MUTATIONS: GuardMutation[] = [
  {
    id: 'retrieve-batch-schema-open-to-extra-keys',
    file: 'retrieve.ts',
    find: "      required: ['hashes'],\n      additionalProperties: false,",
    replace: "      required: ['hashes'],",
    why: 'the batch tool schema losing additionalProperties — the strict-mode registrability the single tool earned would be lost by its sibling, and nothing else reads the schema for it',
  },
  {
    id: 'retrieve-batch-renames-the-frozen-tool',
    file: 'retrieve.ts',
    find: "export const RETRIEVE_TOOL_NAME = 'smelt_retrieve';",
    replace: "export const RETRIEVE_TOOL_NAME = 'smelt_retrieve_batch';",
    why: 'the frozen tool\'s name changed to the batch name — every marker\'s retrieve("hash") now points at a tool taking an array, and the wire-surface freeze is broken by an addition',
  },
  {
    id: 'retrieve-schema-open-to-extra-keys',
    file: 'retrieve.ts',
    find: "      required: ['hash'],\n      additionalProperties: false,",
    replace: "      required: ['hash'],",
    why: 'the retrieve tool schema losing additionalProperties — strict-mode consumers cannot register the tool, and nothing else in the suite reads the schema for registrability',
  },
  {
    id: 'public-surface-ambient-namespace',
    file: 'cli/shell.ts',
    find: 'export type AnswerStream = AsyncIterable<string | Uint8Array>;',
    replace: 'export type AnswerStream = NodeJS.ReadableStream;',
    why: 'an ambient node namespace back in the published type surface — the shipped .d.ts then compiles only where the consumer globally included @types/node',
  },
  {
    kind: 'artifact',
    id: 'sourcemaps-stop-inlining-sources',
    file: 'tsconfig.json',
    find: '"inlineSources": true,',
    replace: '"inlineSources": false,',
    why: 'the emitted .js.map files going back to naming ../src/*.ts, a path the tarball never carries — dead maps for every consumer',
  },
  {
    kind: 'artifact',
    id: 'public-surface-bare-buffer',
    file: 'dist/repomap/reader.d.ts',
    find: '    read(path: string): Uint8Array;',
    replace: '    read(path: string): Buffer;',
    why: "`Buffer` back on an exported interface — a bare @types/node global, invisible to the namespace rule, and an error in smelt's own shipped .d.ts for every consumer building with skipLibCheck: false and no node types of their own",
  },
  {
    kind: 'artifact',
    id: 'public-surface-bare-url',
    file: 'dist/net/policy.d.ts',
    find: 'export declare function assertLocalResource(input: string | LocalResource): LocalResource;',
    replace: 'export declare function assertLocalResource(input: string | LocalResource): URL;',
    why: '`URL` back in an exported signature — the second bare global the namespace rule could not see, and two more errors in the shipped .d.ts for a consumer with no node types at their own root',
  },
];

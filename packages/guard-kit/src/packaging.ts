import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';

import { stripStringsAndComments } from './source.ts';

/**
 * PACKAGING — the guards' machine for auditing the *tarball*, not the repository.
 *
 * Three of smelt's worst consumer-facing bugs were all invisible to a repo-level
 * check, because each was a property of the bytes npm packs rather than of any file
 * under `src`:
 *
 *  - a shipped `.d.ts` naming an ambient namespace (`NodeJS.ReadableStream`), which
 *    only resolves inside a compilation that pulled `@types/node` into its *global*
 *    scope — so a consumer building with `skipLibCheck: false` failed on smelt's
 *    declarations, in smelt's own `node_modules`, with nothing they could fix;
 *  - every `.js.map` and `.d.ts.map` pointing at `../src/*.ts`, a directory `files`
 *    deliberately excludes — go-to-definition and stack traces landing on a path that
 *    was never published;
 *  - a tool schema that a strict-structured-outputs consumer cannot register.
 *
 * So the checks below run over an extracted tarball. `packPackage` runs the real
 * `npm pack` (with `--ignore-scripts`: the guard audits the `dist` the build just
 * produced, and re-running `prepack` inside a test would rebuild the world), and each
 * rule returns *violations as sentences* rather than throwing, so a guard can assert
 * one empty array and print everything that is wrong at once.
 */

/** An extracted tarball: where its `package/` directory is, and what is inside it. */
export interface PackedPackage {
  /** The extracted `package/` directory — the root a consumer's `node_modules` sees. */
  readonly root: string;
  /** Every packed file, as a package-relative POSIX path (`dist/cli/init.d.ts`). */
  readonly files: readonly string[];
  /** Remove the scratch directory. Call from `afterAll`. */
  readonly cleanup: () => void;
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${String(result.status)}):\n` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function walk(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, root));
    else found.push(relative(root, full).split(sep).join(posix.sep));
  }
  return found;
}

/**
 * Pack the package and extract it. The tarball is the artefact under audit: what npm
 * would publish, `files` filter and all.
 *
 * `--ignore-scripts` is deliberate. `prepack` rebuilds and regenerates, which a guard
 * must not do: the point is to audit the `dist` that `pnpm verify` just built, not a
 * fresh one this test made for itself.
 */
export function packPackage(packageDir: string): PackedPackage {
  const scratch = mkdtempSync(join(tmpdir(), 'smelt-pack-'));
  try {
    const printed = run(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', scratch],
      packageDir,
    );
    const tarball = printed
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`npm pack printed no tarball name:\n${printed}`);
    run('tar', ['-xzf', join(scratch, tarball)], scratch);
    const root = join(scratch, 'package');
    return {
      root,
      files: walk(root, root),
      cleanup: () => void rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The ambient namespaces a *types package* contributes to global scope, as opposed to
 * the ones `lib` gives every compilation. A declaration naming one of these compiles
 * only where that types package was globally included — which is the consumer's
 * configuration, not smelt's, and not something smelt may assume.
 *
 * A list, because a guard can only check names it knows; it is the shipped surface's
 * backstop, and the source-level rule beside it ("no smelt module names one at all")
 * is what a mutation can be watched breaking.
 */
export const AMBIENT_GLOBAL_NAMESPACES: readonly string[] = ['NodeJS', 'Deno', 'Bun', 'Chai'];

/**
 * Bare globals a *types package* (or the `dom` lib) supplies — the ones a namespace
 * check cannot see.
 *
 * `NodeJS.ReadableStream` announces itself with a dot. `Buffer` and `URL` do not, and
 * both reached the published surface after the namespace rule was written:
 * `RepoReader.read(path): Buffer` and `assertLocalResource(input: string | URL): URL`
 * were errors in smelt's own `.d.ts` for every consumer compiling with
 * `skipLibCheck: false` and no node types of their own, and nothing reported it.
 *
 * This is still a list, and a list is still only as good as its entries — which is why
 * it is the *pairing*, not the rule. The rule is
 * {@link standaloneTypecheckViolations}, which asks a compiler instead of a list; this
 * exists because a tarball cannot be mutated and a source file can.
 */
export const AMBIENT_GLOBAL_TYPES: readonly string[] = [
  'Buffer',
  'URL',
  'URLSearchParams',
  'Blob',
  'AbortSignal',
  'AbortController',
  'ReadableStream',
  'WritableStream',
  'Headers',
  'Request',
  'Response',
];

/**
 * Every {@link AMBIENT_GLOBAL_TYPES} name `code` uses **as a type**.
 *
 * Type position is approximated by exclusion, because that is the distinction that
 * matters: a value use (`Buffer.from(bytes)`, `new URL(href)`) is compiled away and
 * never reaches a `.d.ts`, while a type use is copied into one verbatim. So a name
 * preceded by `new`, or followed by `.` or `(`, is a value and is allowed; anything
 * else is a type annotation and is not. Pass source with strings and comments already
 * stripped — a doc comment must stay free to explain why the name is not used.
 */
export function ambientTypeUses(code: string): readonly string[] {
  const found = new Set<string>();
  for (const name of AMBIENT_GLOBAL_TYPES) {
    const pattern = new RegExp(`(?<!\\bnew\\s{1,20})\\b${name}\\b(?![\\s]*[.(])`, 'g');
    if (pattern.test(code)) found.add(name);
  }
  return [...found];
}

/** `/// <reference types="node" />` and friends, which *do* pull the namespace in. */
function referencedTypePackages(source: string): readonly string[] {
  return [...source.matchAll(/\/\/\/\s*<reference\s+types=["']([^"']+)["']\s*\/>/g)].map(
    (match) => match[1]!,
  );
}

/**
 * Every shipped `.d.ts` that names an ambient global namespace without a
 * `/// <reference types="…" />` that would supply it.
 *
 * Comments and strings are stripped first: a declaration is allowed to *discuss*
 * `NodeJS.ReadableStream` in the doc comment explaining why it does not use it.
 */
export function ambientNamespaceViolations(packed: PackedPackage): readonly string[] {
  const violations: string[] = [];
  for (const file of packed.files) {
    if (!file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(packed.root, file), 'utf8');
    const referenced = referencedTypePackages(source);
    // A `types` reference is the escape hatch the TypeScript handbook names, so any
    // reference at all satisfies the rule — the point is that the file asks for what
    // it needs instead of hoping the consumer already had it.
    if (referenced.length > 0) continue;
    const code = stripStringsAndComments(source);
    for (const namespace of AMBIENT_GLOBAL_NAMESPACES) {
      if (new RegExp(`\\b${namespace}\\s*\\.`).test(code)) {
        violations.push(
          `${file} names the ambient namespace \`${namespace}\` with no ` +
            `\`/// <reference types="…" />\` to supply it — it typechecks only where the ` +
            `consumer happened to pull those types into global scope. Describe the shape ` +
            `structurally instead.`,
        );
      }
    }
  }
  return violations;
}

/** What {@link standaloneTypecheckViolations} needs to build a consumer around the tarball. */
export interface StandaloneTypecheckOptions {
  /** The `tsc` binary to run. */
  readonly tsc: string;
  /** The source package directory the tarball came from; its `node_modules` resolves the deps. */
  readonly packageDir: string;
  /**
   * `lib` for the consumer's compilation. The default is deliberately just the
   * language: no `dom`, so a declaration leaning on `URL` or `Blob` is caught rather
   * than accidentally satisfied by a lib a Node consumer never asks for.
   */
  readonly lib?: readonly string[];
}

/** One TypeScript diagnostic, as `tsc --pretty false` prints it. */
interface Diagnostic {
  readonly file: string;
  readonly text: string;
}

const DIAGNOSTIC =
  /^(?<file>[^(]+)\((?<row>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.+)$/;

function parseDiagnostics(output: string, cwd: string): readonly Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (match?.groups === undefined) continue;
    found.push({
      file: resolve(cwd, match.groups['file']!),
      text: `${match.groups['code']!}: ${match.groups['message']!}`,
    });
  }
  return found;
}

/**
 * Typecheck the tarball the way a *strict* consumer does, and report every error
 * TypeScript raises inside the package's own shipped files.
 *
 * This is the check the ambient-namespace rule could not be. That rule matches
 * `Namespace.`-dotted names, so it is structurally blind to a bare global: `Buffer` on
 * an exported interface and `URL` in an exported signature both sailed past it, and
 * both were errors in smelt's own `.d.ts` on the machine of every consumer building
 * with `skipLibCheck: false` and no node types of their own. A guard that only knows
 * the names it was told cannot find the next one. A compiler can.
 *
 * So: the extracted tarball is symlinked into a scratch project under its published
 * name, its declared dependencies are symlinked beside it (resolved from the real
 * package, so the versions are the ones it ships against), and `tsc` runs over
 * `export * from '<name>'` with `strict`, `skipLibCheck: false` and `types: []` — the
 * configuration in which nothing is silently supplied. `export *` pulls in the whole
 * declaration graph a consumer can reach, which is exactly the surface at issue.
 *
 * **Only diagnostics in the package's own files are returned.** A dependency's
 * declarations are not smelt's to fix — `web-tree-sitter` needs `@types/emscripten`
 * and asks for it nowhere — and folding those in would make this guard fail for a
 * reason no change to this repository can address. That boundary is exactly the claim
 * being made: smelt's shipped declarations typecheck on their own.
 */
export function standaloneTypecheckViolations(
  packed: PackedPackage,
  options: StandaloneTypecheckOptions,
): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(packed.root, 'package.json'), 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  // The consumer is built *beside* the extracted tarball, not in a scratch of its own,
  // because TypeScript resolves symlinks before walking up for `node_modules`: a
  // package symlinked into some other directory looks for its own dependencies from
  // wherever it really lives. Putting `node_modules` next to the extracted `package/`
  // is precisely the arrangement pnpm gives a real consumer.
  const projectRoot = resolve(packed.root, '..');
  const modules = join(projectRoot, 'node_modules');
  const consumer = join(projectRoot, 'consumer');
  try {
    rmSync(modules, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
    mkdirSync(consumer, { recursive: true });
    linkModule(modules, manifest.name, packed.root);
    // Peers are linked beside the runtime dependencies, and they have to be: a peer is
    // by contract already in the consumer's tree — that is what makes it a peer rather
    // than a dependency — so omitting it would report an unresolved import that no real
    // consumer can see, and every adapter package that implements an interface from its
    // peer would fail this check for being built correctly.
    const linked = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    for (const dependency of new Set(linked)) {
      linkModule(modules, dependency, dependencyDir(options.packageDir, dependency));
    }
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            // The whole point: no declaration is skipped, and nothing sits in global
            // scope that the consumer did not ask for.
            skipLibCheck: false,
            types: [],
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
            lib: options.lib ?? ['es2023'],
            noEmit: true,
          },
          files: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(consumer, 'consumer.ts'),
      `export * from ${JSON.stringify(manifest.name)};\n`,
    );

    const result = spawnSync(options.tsc, ['-p', 'tsconfig.json', '--pretty', 'false'], {
      cwd: consumer,
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const diagnostics = parseDiagnostics(output, consumer);
    if (result.status !== 0 && diagnostics.length === 0) {
      throw new Error(`tsc printed no diagnostic this guard can read:\n${output}`);
    }
    const own = resolve(packed.root);
    return diagnostics
      .filter((diagnostic) => diagnostic.file.startsWith(`${own}${sep}`))
      .map(
        (diagnostic) =>
          `${relative(own, diagnostic.file).split(sep).join(posix.sep)} — ${diagnostic.text} ` +
          `(a consumer building with skipLibCheck: false and types: [] fails here, inside ` +
          `smelt's own node_modules, on a file they cannot edit; state the shape structurally)`,
      );
  } finally {
    rmSync(modules, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
}

/** Symlink one package into a scratch `node_modules`, scope directory and all. */
function linkModule(modules: string, name: string, target: string): void {
  const path = join(modules, ...name.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  symlinkSync(target, path, 'dir');
}

/**
 * Where the real package resolves one of its dependencies — the version it ships
 * against, symlinks and all.
 *
 * Walked by hand rather than through `require.resolve`, because a package is free to
 * hide `./package.json` behind its `exports` map (`web-tree-sitter` does), and this
 * wants the directory, not an entrypoint.
 */
function dependencyDir(packageDir: string, dependency: string): string {
  const resolver = createRequire(join(packageDir, 'package.json'));
  for (const base of resolver.resolve.paths(dependency) ?? []) {
    const candidate = join(base, ...dependency.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`cannot find the installed \`${dependency}\` from ${packageDir}`);
}

interface SourceMap {
  readonly sources?: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
  readonly sourceRoot?: string;
}

/**
 * Every shipped sourcemap that resolves to nothing on a consumer's machine.
 *
 * A map is honest one of two ways: it carries its sources inline (`sourcesContent`),
 * or every path in `sources` is a file that is actually in the tarball. Anything else
 * is a map that only worked in the repository it was built in.
 */
export function deadSourcemapViolations(packed: PackedPackage): readonly string[] {
  const inTarball = new Set(packed.files);
  const violations: string[] = [];
  for (const file of packed.files) {
    if (!file.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(join(packed.root, file), 'utf8')) as SourceMap;
    const sources = map.sources ?? [];
    if (sources.length === 0) {
      violations.push(`${file} names no sources at all`);
      continue;
    }
    const content = map.sourcesContent;
    if (
      Array.isArray(content) &&
      content.length === sources.length &&
      content.every((entry) => typeof entry === 'string')
    ) {
      continue;
    }
    for (const source of sources) {
      // Resolved the way a debugger resolves it: relative to the map's own location.
      const absolute = resolve(join(packed.root, file), '..', map.sourceRoot ?? '', source);
      const packedPath = relative(packed.root, absolute).split(sep).join(posix.sep);
      if (!inTarball.has(packedPath)) {
        violations.push(
          `${file} points at "${source}", which resolves to ${packedPath} — not in the ` +
            `tarball. Inline the sources (sourcesContent) or ship them.`,
        );
      }
    }
  }
  return violations;
}

/** The subset of JSON Schema these rules read. */
export interface ToolSchema {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly unknown[];
  readonly additionalProperties?: unknown;
}

/**
 * The rules OpenAI's structured-outputs **strict mode** enforces before it will accept
 * a function schema at all: every object states `additionalProperties: false`, and
 * `required` names every key in `properties`.
 *
 * Nothing here loosens or widens a tool: a schema satisfying these describes exactly
 * the same accepted values as one that already ignored unknown keys and treated every
 * listed key as mandatory. It is the *same shape, stated precisely enough to register*.
 */
export function strictModeViolations(schema: ToolSchema, label: string): readonly string[] {
  const violations: string[] = [];
  if (schema.type !== 'object') {
    violations.push(`${label}: type is ${JSON.stringify(schema.type)}, not "object"`);
  }
  if (schema.additionalProperties !== false) {
    violations.push(
      `${label}: strict mode requires \`additionalProperties: false\` — without it the ` +
        `schema cannot be registered as a strict function at all, and a whole class of ` +
        `consumer simply cannot expose the tool.`,
    );
  }
  const properties = Object.keys(schema.properties ?? {});
  const required = new Set((schema.required ?? []).map((entry) => String(entry)));
  for (const property of properties) {
    if (!required.has(property)) {
      violations.push(
        `${label}: "${property}" is a property but is not in \`required\` — strict mode ` +
          `requires every property to be required.`,
      );
    }
  }
  for (const entry of required) {
    if (!properties.includes(entry)) {
      violations.push(`${label}: \`required\` names "${entry}", which is not a property`);
    }
  }
  return violations;
}

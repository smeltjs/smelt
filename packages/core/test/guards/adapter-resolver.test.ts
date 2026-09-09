import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAdapter } from '@guard/rerank/resolve';

import type { GuardMutation } from './_mutations.ts';

/**
 * ADAPTER-RESOLVER GUARD — an opt-in adapter is looked for where the *consumer* could
 * have put it.
 *
 * ADR-0004's bargain is that the network client is a package the consumer installs.
 * That bargain is only kept if the directory smelt searches is one they can install
 * into, and for two of the three shapes smelt ships in it was not: a `smelt.config.json`
 * in `$HOME` (InstallScope `user`) with a global `smelt` resolved the adapter out of a
 * Homebrew keg or an `npm -g` prefix, then refused with `npm install <pkg>` — a command
 * that installs into the shell's cwd, which is neither of the places just searched. The
 * user did as they were told, twice, and smelt refused both times.
 *
 * Four properties, each with a mutation in `pnpm mutate`:
 *
 *  1. **The config file's directory is asked first.** Not smelt's own location, and not
 *     only as a fallback: a package beside the config wins.
 *  2. **Smelt's own install is still asked.** A project-local `npm install` beside the
 *     package must keep working, which is the case that was never broken.
 *  3. **One refusal names both places and the command that fixes it.** A refusal naming
 *     one place is how the original bug survived being reported.
 *  4. **What comes back is a `file:` URL, never the package name.** Handing the bare
 *     specifier back to `import()` puts the adapter's name in a position the Law 1 walk
 *     reads as an edge, and resolves it from smelt's location again — the bug and the
 *     Law 1 arrangement break together, which is why they are guarded together.
 *
 * No install and no network: an "installed" package below is a directory holding a
 * `package.json` and one file, which is all a resolver ever wanted from one.
 */

const PACKAGE = '@fake/adapter';

/** A resolvable package under `<dir>/node_modules/<name>`. No install, no network. */
function install(dir: string, name: string): string {
  const home = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' })}\n`,
  );
  writeFileSync(join(home, 'index.js'), `export const id = '${dir}';\n`);
  return join(home, 'index.js');
}

describe('an opt-in adapter is looked for where the consumer could have installed it', () => {
  let configDir: string;
  let ownDir: string;

  beforeEach(() => {
    // Real paths: `require.resolve` answers in them, and macOS hands out a
    // `/var/folders/...` symlink for `/private/var/folders/...`.
    configDir = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-guard-config-')));
    ownDir = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-guard-own-')));
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(ownDir, { recursive: true, force: true });
  });

  const configPath = () => join(configDir, 'smelt.config.json');

  /** Smelt's own install, as the seam sees it: a resolver rooted in the other dir. */
  const ownRequire = {
    resolve: (specifier: string) => {
      const entry = join(ownDir, 'node_modules', ...specifier.split('/'), 'index.js');
      if (!existsSync(entry)) throw new Error(`Cannot find module '${specifier}'`);
      return entry;
    },
  };

  it('asks the config file’s directory first, and says so', () => {
    // The property the whole module exists for. Installed beside the config and
    // nowhere else: a resolver that consulted only smelt's own location finds nothing.
    install(configDir, PACKAGE);

    const found = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(
      found.found,
      'an adapter installed beside smelt.config.json was not found. The config file’s ' +
        'own directory is the one place the consumer can be sure of — a user-scope ' +
        'config with a Homebrew or `npm -g` smelt has no other.',
    ).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('config');
    expect(found.url).toContain(configDir);
  });

  it('still falls back to smelt’s own install, for the project-local case', () => {
    install(ownDir, PACKAGE);

    const found = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('core');
    expect(found.url).toContain(ownDir);
  });

  it('prefers the config file’s directory when both places have it', () => {
    install(configDir, PACKAGE);
    install(ownDir, PACKAGE);

    const found = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('config');
  });

  it('refuses in ONE message naming both places tried and the command that fixes it', () => {
    const missing = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(missing.found).toBe(false);
    if (missing.found) return;
    for (const named of [configDir, missing.ownDir, missing.install]) {
      expect(
        missing.why,
        'the refusal does not name every place smelt looked and the command that fixes ' +
          'it. A refusal naming one directory is how a user installs into the wrong one ' +
          'and is refused again for the same reason.',
      ).toContain(named);
    }
  });

  it('names an install command that targets the config file’s directory', () => {
    const missing = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(missing.found).toBe(false);
    if (missing.found) return;
    // `npm install --prefix <dir> <pkg>` puts the package in `<dir>/node_modules` —
    // npm's own rule (`--prefix` sets the local prefix outright, and a local install
    // stores under it), checked against a scratch directory rather than assumed. A
    // command without `--prefix` installs into whatever shell the reader is in, which
    // is the one directory this resolver never searches.
    expect(missing.install).toContain('--prefix');
    expect(missing.install).toContain(configDir);
    expect(missing.install).toContain(PACKAGE);
  });

  it('hands back a file: URL, never the package name', () => {
    // The Law 1 half. `import()` of a bare specifier is an edge the zero-network walk
    // follows and a bundler resolves — and it would resolve from smelt's own location,
    // undoing the search above at the same time. One value keeps both true.
    const entry = install(configDir, PACKAGE);
    const found = resolveAdapter(PACKAGE, configPath(), { ownRequire });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(
      found.url.startsWith('file:'),
      `resolveAdapter returned "${found.url}". It must be a file: URL: a bare specifier ` +
        `handed to import() is an import edge, and it resolves from smelt's own location.`,
    ).toBe(true);
    expect(found.url).not.toBe(PACKAGE);
    expect(decodeURIComponent(found.url)).toContain(entry);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'adapter-resolver-skips-the-config-dir',
    file: 'rerank/resolve.ts',
    find: 'const beside = tryResolve(createRequire(resolvePath(configPath)), name);',
    replace: 'const beside = tryResolve(io.ownRequire ?? ownRequireDefault, name);',
    why: 'the resolver asking smelt’s own location twice instead of the config file’s directory — the original bug exactly, and it is invisible in a project-local checkout where the two are the same place, which is why it shipped',
  },
  {
    id: 'adapter-resolver-drops-its-own-install',
    file: 'rerank/resolve.ts',
    find: 'const own = tryResolve(io.ownRequire ?? ownRequireDefault, name);',
    replace: 'const own = undefined;',
    why: 'the fallback dropped while adding the new first choice — a project that installed the adapter beside @smeltjs/core would start being refused for a package it has',
  },
  {
    id: 'adapter-refusal-names-one-place',
    file: 'rerank/resolve.ts',
    find: '`${name} is not installed. smelt looked beside ${CONFIG_FILE_NAME} (${configDir}) ` +',
    replace: '`${name} is not installed. ` +',
    why: 'a refusal that names smelt’s own install and not the config file’s directory — the shape of the original message, which sent the reader to install into a directory smelt does not search',
  },
  {
    id: 'adapter-install-command-forgets-the-prefix',
    file: 'rerank/resolve.ts',
    find: 'return `npm install --prefix ${dir} ${name}`;',
    replace: 'return `npm install ${name}`;',
    why: '`npm install <pkg>` installs into whatever directory the shell is in, which is the one place the resolver never looks — a repair command that cannot repair anything is worse than none, because the reader believes they tried',
  },
];

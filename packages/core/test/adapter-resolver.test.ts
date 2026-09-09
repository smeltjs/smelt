import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME } from '../src/config.ts';
import { resolveAdapter } from '../src/rerank/resolve.ts';

/**
 * THE ADAPTER RESOLVER — which directory an opt-in adapter is looked for in.
 *
 * The failure this seam exists for: a `smelt.config.json` in `$HOME` (InstallScope
 * `user`) plus a global `smelt` used to resolve the adapter package from smelt's own
 * location, which for a Homebrew keg or an `npm -g` prefix is not a directory anybody
 * can install into. Two temp directories per case, no install and no network — the
 * "installed" adapter below is a folder with a `package.json` and one file in it, which
 * is all `require.resolve` and `import()` ever needed it to be.
 */

const PACKAGE = '@fake/adapter';

/** A resolvable package under `<dir>/node_modules/<name>`, exporting one marker. */
function installFake(dir: string, name: string, marker: string): string {
  const home = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' })}\n`,
  );
  writeFileSync(join(home, 'index.js'), `export const marker = '${marker}';\n`);
  return join(home, 'index.js');
}

/**
 * The same package, reachable only under the `import` condition — which is what a great
 * many ESM-only packages publish, and what `createRequire(...).resolve()` cannot answer.
 */
function installEsmOnly(dir: string, name: string): void {
  const home = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'package.json'),
    `${JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      exports: { '.': { import: './index.js' } },
    })}\n`,
  );
  writeFileSync(join(home, 'index.js'), `export const marker = 'esm-only';\n`);
}

describe('resolveAdapter: the config file’s directory first, smelt’s own install second', () => {
  let configDir: string;
  let coreDir: string;
  let configPath: string;

  beforeEach(() => {
    // `realpathSync`, because `require.resolve` answers in real paths and macOS hands
    // out a `/var/folders/...` symlink for `/private/var/folders/...`.
    configDir = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-adapter-config-')));
    coreDir = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-adapter-core-')));
    configPath = join(configDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, `${JSON.stringify({ smeltConfig: 1 })}\n`);
  });
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(coreDir, { recursive: true, force: true });
  });

  /** Smelt's own install, as a seam: a resolver rooted in the other temp directory. */
  const ownRequire = () => ({
    resolve: (specifier: string) => {
      const found = join(coreDir, 'node_modules', ...specifier.split('/'), 'index.js');
      if (!existsSync(found)) throw new Error(`Cannot find module '${specifier}'`);
      return found;
    },
  });

  it('resolves a package installed beside the config file, and says it came from there', () => {
    const entry = installFake(configDir, PACKAGE, 'from-config');

    const found = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('config');
    expect(fileURLToPath(found.url)).toBe(entry);
  });

  it('falls back to smelt’s own install, and says which of the two answered', () => {
    const entry = installFake(coreDir, PACKAGE, 'from-core');

    const found = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('core');
    expect(fileURLToPath(found.url)).toBe(entry);
  });

  it('prefers the config file’s directory when both have it', () => {
    installFake(configDir, PACKAGE, 'from-config');
    installFake(coreDir, PACKAGE, 'from-core');

    const found = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.from).toBe('config');
  });

  it('refuses with ONE message naming both places tried and the command that fixes it', () => {
    const missing = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(missing.found).toBe(false);
    if (missing.found) return;
    expect(missing.reason).toBe('missing');
    expect(missing.configDir).toBe(configDir);
    // The directory is quoted: real paths have spaces in them, and an unquoted one
    // makes the command smelt printed two arguments npm cannot use.
    expect(missing.install).toBe(`npm install --prefix "${configDir}" ${PACKAGE}`);
    // Both places, in one sentence — a refusal that named only one of them would send
    // the reader to install into the directory that was not the problem.
    expect(missing.why).toContain(configDir);
    expect(missing.why).toContain(missing.ownDir);
    expect(missing.why).toContain(missing.install ?? '');
  });

  it('hands back a file: URL, so a Windows path shape is a legal import specifier', () => {
    const entry = installFake(configDir, PACKAGE, 'from-config');

    const found = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(found.found).toBe(true);
    if (!found.found) return;
    // `pathToFileURL` is the whole point: `C:\Users\me\node_modules\…` is not a URL,
    // and `import()` of a bare Windows path is a package specifier, not a file.
    expect(found.url).toBe(pathToFileURL(entry).href);
    expect(found.url.startsWith('file:')).toBe(true);
  });

  it('what it resolves is importable — the URL is the one `import()` takes', async () => {
    installFake(configDir, PACKAGE, 'from-config');

    const found = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });
    expect(found.found).toBe(true);
    if (!found.found) return;
    const loaded = (await import(found.url)) as { marker: string };

    expect(loaded.marker).toBe('from-config');
  });

  it('an ESM-only package is “installed and unreachable”, not “not installed”', () => {
    // The refusal that would otherwise be a lie. `createRequire(...).resolve()` asks
    // under Node's `require` conditions, so a package whose `exports` map answers only
    // `import` throws — and swallowing that into "not installed" hands the reader an
    // `npm install` for a package they already have, which they run, and which changes
    // nothing.
    installEsmOnly(configDir, PACKAGE);

    const blocked = resolveAdapter(PACKAGE, configPath, { ownRequire: ownRequire() });

    expect(blocked.found).toBe(false);
    if (blocked.found) return;
    expect(blocked.reason).toBe('unreachable');
    expect(blocked.install, 'an install command for a package that is installed').toBeUndefined();
    expect(blocked.why).toContain(configDir);
    expect(blocked.why).toContain('installed at');
    expect(blocked.why).toContain('require');
    expect(blocked.why).not.toContain('npm install');
  });

  it('says which of the two directories holds the unreachable copy', () => {
    installEsmOnly(coreDir, PACKAGE);

    const blocked = resolveAdapter(PACKAGE, configPath, {
      ownRequire: {
        resolve: (specifier: string) => {
          // The seam stands in for smelt's own `require`, so it must fail the way one
          // does: with Node's own code, not a bare Error.
          const error: Error & { code?: string } = new Error(
            `No "exports" main defined in ${join(coreDir, 'node_modules', specifier, 'package.json')}`,
          );
          error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
          throw error;
        },
      },
    });

    expect(blocked.found).toBe(false);
    if (blocked.found) return;
    expect(blocked.reason).toBe('unreachable');
    expect(blocked.why).toContain(blocked.ownDir);
  });

  it('names smelt’s own install by its package directory, never by a module file', () => {
    const missing = resolveAdapter(PACKAGE, configPath);

    expect(missing.found).toBe(false);
    if (missing.found) return;
    // `@smeltjs/core`'s own root, from `src/rerank/` in a checkout and from
    // `dist/rerank/` in a tarball alike — the directory a reader could `ls`.
    expect(missing.ownDir.endsWith('.ts')).toBe(false);
    expect(missing.ownDir.endsWith('.js')).toBe(false);
  });
});

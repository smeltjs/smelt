import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { packageRoot, repoRoot } from './guards/_source.ts';

/**
 * Publish-surface pins for `@smeltjs/mcp` — the same facts `packages/core`'s
 * manifest test pins, because they break the same way: quietly, at publish time or
 * on a consumer's machine, never in a unit test.
 */

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly main?: string;
  readonly exports?: Record<string, unknown>;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
  readonly publishConfig?: { readonly access?: string };
  readonly engines?: { readonly node?: string };
  readonly repository?: { readonly url?: string; readonly directory?: string };
  readonly dependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as Manifest;
const core = JSON.parse(
  readFileSync(join(repoRoot(), 'packages/core/package.json'), 'utf8'),
) as Manifest;

describe('the publish surface of package.json', () => {
  it('is @smeltjs/mcp 0.7.0 under Apache-2.0', () => {
    expect(manifest.name).toBe('@smeltjs/mcp');
    expect(manifest.version).toBe('0.7.0');
    expect(manifest.license).toBe('Apache-2.0');
  });

  it('exports ".": types first, then import, then default — all pointing at dist', () => {
    const dot = manifest.exports?.['.'] as Record<string, string> | undefined;
    expect(dot, 'the manifest lost its "." export').toBeDefined();
    expect(Object.keys(dot!)).toEqual(['types', 'import', 'default']);
    expect(dot!['types']).toBe('./dist/index.d.ts');
    expect(dot!['import']).toBe('./dist/index.js');
    expect(dot!['default']).toBe('./dist/index.js');
  });

  it('ships one bin, so `npx @smeltjs/mcp` runs it with no name given', () => {
    expect(manifest.bin).toEqual({ 'smelt-mcp': 'dist/bin.js' });
  });

  it('packs dist and the README, and nothing that is not built for consumers', () => {
    expect(manifest.files).toEqual(['dist', 'README.md']);
  });

  it('carries a node10 main field agreeing with the exports map', () => {
    expect(manifest.main).toBe('./dist/index.js');
  });

  it('declares public access, so the scoped first publish cannot fail on the default', () => {
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('keeps the engines floor identical to @smeltjs/core — one install, one floor', () => {
    expect(manifest.engines?.node).toBe(core.engines?.node);
    expect(manifest.engines?.node).toBe('^20.19.0 || >=22.12.0');
  });

  it('names the monorepo with its package directory', () => {
    expect(manifest.repository?.url).toBe('git+https://github.com/smeltjs/smelt.git');
    expect(manifest.repository?.directory).toBe('packages/mcp');
  });

  it('depends on @smeltjs/core through the workspace, caret-ranged', () => {
    expect(manifest.dependencies?.['@smeltjs/core']).toBe('workspace:^');
  });
});

describe('the packaged LICENSE', () => {
  it('exists inside the package directory and is byte-identical to the root LICENSE', () => {
    const root = readFileSync(join(repoRoot(), 'LICENSE'), 'utf8');
    const packaged = readFileSync(join(packageRoot(), 'LICENSE'), 'utf8');
    expect(root).toContain('Apache License');
    expect(
      packaged === root,
      'packages/mcp/LICENSE has drifted from the root LICENSE — re-copy it ' +
        '(cp LICENSE packages/mcp/LICENSE)',
    ).toBe(true);
  });
});

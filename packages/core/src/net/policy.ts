import { NetworkPolicyError } from '../errors.ts';

/**
 * Law 1 — zero network in v1 — written down once, in one place, so that the guard
 * test and the runtime check cannot drift apart. `test/guards/no-network.test.ts`
 * imports these lists and fails if any module reachable from the public entrypoint
 * imports one of them.
 *
 * This is a *partition of a discovered set*, not an allowlist over an assumed one:
 * the guard walks the real import graph and classifies every edge it finds. A new
 * transport nobody thought of still gets classified — as an unknown bare import,
 * which the guard reports rather than ignores.
 */
export const FORBIDDEN_NODE_MODULES: readonly string[] = [
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
];

/** Third-party transports. A dependency that pulls one in is a Law 1 violation too. */
export const FORBIDDEN_PACKAGES: readonly string[] = [
  'undici',
  'axios',
  'node-fetch',
  'got',
  'ky',
  'superagent',
  'ws',
  'socket.io-client',
  'eventsource',
];

/**
 * Globals that reach the network without an import. Grepped for by the guard — both
 * bare (`fetch(…)`) and qualified through a global object (`globalThis.fetch(…)`),
 * which is why `globalThis` and `global` are themselves on the list: an access
 * routed through the global object is the escape hatch around a bare-name grep.
 */
export const FORBIDDEN_GLOBALS: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'globalThis',
  'global',
];

/**
 * The other half of the partition.
 *
 * A forbidden-list alone is an allowlist over an assumed set: it can only catch
 * transports somebody already thought of. So the guard classifies *every* import edge
 * it discovers, and an edge that matches neither the forbidden lists nor these
 * permitted ones **fails the build**. Adding a dependency therefore requires adding it
 * here, in a diff, next to the reason — which is the point.
 */
export const ALLOWED_NODE_BUILTINS: readonly string[] = [
  'node:crypto', // content hashing for the elision store
  'node:fs', // reading grammar .wasm files off disk
  'node:fs/promises',
  'node:path',
  'node:url',
  'node:buffer',
  // `createRequire`, for two resolvers and nothing else: web-tree-sitter's own loader
  // shim, and `rerank/resolve.ts`, which asks Node where an opt-in adapter is
  // installed. Both only *resolve* — they turn a name into a path on this machine
  // and open nothing. The rerank one hands its answer back as a `file:` URL, so the
  // adapter's name never reaches an `import()` as a literal and the walk below still
  // finds no edge to it.
  'node:module',
  'node:util', // parseArgs, for the CLI. Argument parsing with zero dependencies.
  'node:process', // argv, stdin/stdout/stderr and the exit code, for the CLI
  'node:os', // homedir(), for `smelt hooks install` harness detection — reads a path, opens nothing
  'node:tty', // isatty(0) for the CLI's TTY check — a plain syscall, no stream, no socket
  // `smelt doctor`'s hook probe, and nothing else: it runs THIS node
  // (`process.execPath`) on a script an installed hook entry already names, to learn
  // whether that entry still does anything. A spawn is not a transport, but it is the
  // one builtin on this list that could be turned into one, so the ruling is narrower
  // than the import: `test/guards/hook-command.test.ts` asserts that every spawn call
  // under `src/` names `process.execPath` as its program, and goes red on any other.
  'node:child_process',
];

/**
 * THE OPT-IN RERANK BUCKET — packages a `rerank` config block may load **at runtime**,
 * and that no smelt module may **import**.
 *
 * ADR-0004 reopened one thing: a consumer may name a reranker in a config file they
 * wrote. It did not reopen Law 1, and this constant is the line between the two.
 * `@smeltjs/rerank-voyage` reaches the network — it says so at the top of its own index
 * and in its own README — so it is not on {@link ALLOWED_PACKAGES}, is not a dependency
 * of this package, and never will be.
 *
 * The name is spelled **here and nowhere else in `src`**, as data. `rerank/load.ts`
 * imports this constant and hands it to `import()`, so the specifier the loader uses is
 * a *value*: the zero-network walk follows literal specifiers, sees no edge, and the
 * package is genuinely absent from the graph rather than excluded from it. The
 * arrangement is only honest if the guard can tell the two apart, so it does — the
 * ruling in `test/guards/no-network.test.ts` classifies any import of a name on this
 * list as **forbidden**, and two mutations prove it goes red: a static import of the
 * adapter anywhere in the graph, and the loader's dynamic import spelled with a string
 * literal instead of this constant.
 *
 * (The guard's import scanner reads raw source, so neither of those two spellings may
 * appear even inside a comment in this repository — which is why the paragraph above
 * describes the mutations rather than quoting them.)
 *
 * Read that as the rule it is: *smelt may know this package's name; smelt may not
 * depend on it.*
 */
export const RERANK_VOYAGE_PACKAGE = '@smeltjs/rerank-voyage';

/** Every opt-in adapter package, by name. One today. See {@link RERANK_VOYAGE_PACKAGE}. */
export const OPT_IN_RERANK_PACKAGES: readonly string[] = [RERANK_VOYAGE_PACKAGE];

/** Third-party packages any smelt module may import. Keep this list boring and short. */
export const ALLOWED_PACKAGES: readonly string[] = [
  'web-tree-sitter', // WASM parsers. No native build step, no download at runtime.
  'tree-sitter-wasms', // prebuilt grammar .wasm blobs, resolved to local file paths
];

/**
 * The only URL schemes any smelt code path may resolve.
 *
 * This is not paranoia about our own code. `web-tree-sitter`'s `Language.load()`
 * accepts a `string | URL`, and an `https:` URL there would fetch a grammar over the
 * wire — a real network call inside the elision path, from a dependency's happy path.
 * Every resource smelt hands to a loader goes through {@link assertLocalResource} first.
 */
export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:'];

/**
 * The parsed resource {@link assertLocalResource} takes and hands back.
 *
 * A WHATWG `URL` satisfies it, and one is what comes back at runtime — but `URL` is
 * *stated* structurally here, for the reason `AnswerStream` is not
 * `NodeJS.ReadableStream` and `RepoReader.read` returns `Uint8Array`: `URL` is a
 * global that only a compilation which pulled in `@types/node` (or the DOM lib) has,
 * so naming it in an exported signature put two errors into the shipped `.d.ts` for
 * every consumer building with `skipLibCheck: false` and no such types of their own.
 * These are the two members the policy reads and the two its callers use.
 */
export interface LocalResource {
  /** The scheme, with its colon — `'file:'`. */
  readonly protocol: string;
  /** The whole URL, as a string. `fileURLToPath` takes it directly. */
  readonly href: string;
}

/**
 * Reject anything that is not a local file, and return the resolved `file:` URL.
 *
 * @throws {NetworkPolicyError} if the input names a remote scheme.
 */
export function assertLocalResource(input: string | LocalResource): LocalResource {
  const url = toUrl(input);
  if (!ALLOWED_URL_SCHEMES.includes(url.protocol)) {
    throw new NetworkPolicyError(
      `refusing to load "${resourceLabel(input)}": scheme "${url.protocol}" is not local. ` +
        `v1 makes zero network calls; only ${ALLOWED_URL_SCHEMES.join(', ')} is allowed.`,
    );
  }
  return url;
}

const resourceLabel = (input: string | LocalResource): string =>
  typeof input === 'string' ? input : input.href;

function toUrl(input: string | LocalResource): URL {
  // Structural in, structural out: anything carrying an `href` is re-parsed from it,
  // which covers a real `URL` and a `URL` from another realm identically.
  if (typeof input !== 'string') return new URL(input.href);
  // A bare path is a local path. Anything with a scheme is parsed as-is so that
  // "https://evil/grammar.wasm" is caught rather than treated as a relative path.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    try {
      return new URL(input);
    } catch {
      throw new NetworkPolicyError(`refusing to load "${input}": not a parseable URL or path.`);
    }
  }
  return new URL(`file://${input.startsWith('/') ? '' : '/'}${input}`);
}

/**
 * The CLI's edge, in one module: the name people type, where its bytes come from and
 * go, and the codes it hands back to the shell.
 *
 * These three used to live in `args.ts` and `run.ts` — the two modules that now read
 * the subcommand registry. A verb file needs all three, so leaving them there would
 * make `args.ts → subcommands/* → args.ts` a cycle, which is exactly the shape that
 * once forced the `--harness` help list to be hand-typed (see
 * `src/harness/registry.ts`). **This file imports nothing**, so every module under
 * `cli/` can read it and nothing has to be written twice to avoid a loop.
 */

/** The command people type. Independent of the package name. */
export const CLI_NAME = 'smelt';

/**
 * Where a wizard's answers come from: lines of text arriving over time, and nothing
 * more. `process.stdin` is one, a scripted `Readable.from([...])` in a test is
 * another, an async generator is a third.
 *
 * **Stated structurally, never as `NodeJS.ReadableStream`.** A `.d.ts` that names an
 * ambient namespace only typechecks inside a compilation that pulled `@types/node`
 * into its *global* scope, and a consumer building with `skipLibCheck: false` and a
 * narrowed `types` array (or no `@types/node` at its own root — the ordinary case
 * under pnpm) fails on smelt's declarations rather than on their own code. Naming the
 * node type by import does not help: TypeScript resolves `node:stream` — and bare
 * `stream` — only through the same globally-included `@types/node`. So the published
 * surface describes the shape smelt actually consumes, which needs no node types at
 * all, and {@link answerReader} is the one adapter that reads it.
 * `test/guards/packaging.test.ts` holds the shipped declarations to it.
 */
export type AnswerStream = AsyncIterable<string | Uint8Array>;

/**
 * One wizard's answers, one line at a time, plus the release that ends the process.
 *
 * `release` is not housekeeping — it is the difference between a wizard that exits and
 * one the user has to Ctrl-C. See {@link answerReader}.
 */
export interface AnswerReader {
  /** The next line, without its terminator, or `undefined` once input has ended. */
  next(): Promise<string | undefined>;
  /** Stop reading and let go of the source, so nothing it owns keeps the loop alive. */
  release(): Promise<void>;
}

/**
 * Read {@link AnswerStream} as lines — and, when the wizard is done, **let go of it**.
 *
 * This exists because the obvious adapter is a trap. Wrapping the answer stream in
 * `Readable.from(...)` and handing that to `readline` reads the source through *its*
 * async iterator, and closing the readline interface or destroying the wrapper ends
 * only the wrapper: the source is left mid-`next()`, still subscribed, still holding
 * its handle. On the real CLI that source is `process.stdin`, so `smelt init` wrote
 * every file, printed `Done.` and then sat there forever — a hang only visible on an
 * open pipe or a TTY, because EOF happens to end the iteration by itself, and EOF is
 * what every scripted test hands it.
 *
 * So the source's own iterator is held here and nothing else touches it. `release`
 * calls its `return()`, which is the contract an async iterable already has for "I am
 * finished with you": `process.stdin`'s destroys the stream and unrefs the handle, an
 * async generator runs its `finally`, and a plain array iterator does nothing at all.
 * Crucially `release` is called between reads, never during one — an iterator awaiting
 * `next()` cannot be returned out of, which is the very state the `Readable.from`
 * wrapper left the source in.
 *
 * Bytes are decoded as UTF-8 across chunk boundaries, so a multi-byte character split
 * across two reads survives; `\r\n` and a final line with no terminator both behave as
 * readline did.
 */
export function answerReader(input: AnswerStream): AnswerReader {
  const iterator = input[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let ended = false;

  const takeLine = (): string | undefined => {
    const newline = pending.indexOf('\n');
    if (newline === -1) return undefined;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  };

  return {
    async next(): Promise<string | undefined> {
      for (;;) {
        const line = takeLine();
        if (line !== undefined) return line;
        if (ended) {
          if (pending === '') return undefined;
          const last = pending;
          pending = '';
          return last;
        }
        const step = await iterator.next();
        if (step.done === true) {
          ended = true;
          pending += decoder.decode(); // flush a truncated multi-byte sequence
          continue;
        }
        pending +=
          typeof step.value === 'string'
            ? step.value
            : decoder.decode(step.value, { stream: true });
      }
    },
    async release(): Promise<void> {
      ended = true;
      pending = '';
      await iterator.return?.();
    },
  };
}

/**
 * Exit codes, and why there are five of them.
 *
 * A CLI that returns 0 whatever happens is the shell-level version of a stub that
 * returns `[]`: the caller cannot tell success from failure, so a pipeline built on it
 * fails silently. **`overBudget` is the load-bearing one.** A plan that did not fit is
 * not an error — smelt refused to cut the regions the caller asked to keep, which is
 * correct — but it is also not success, and a script must be able to see the
 * difference without parsing prose.
 */
export const EXIT = {
  ok: 0,
  overBudget: 1,
  usage: 2,
  refused: 3,
  unexpected: 4,
} as const;

/** Where the CLI's bytes come from and go. Injected so `runCli` is testable in-process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** All of stdin, as UTF-8. @throws {CliUsageError} when nothing is piped. */
  readonly stdin: () => string;
  /** The package version, for `--version`. */
  readonly version: string;
  /**
   * Where `smelt.config.json` discovery starts, and where `init` writes. Defaults to
   * the process working directory; tests pass a temp directory to stay hermetic.
   */
  readonly cwd?: string;
  /**
   * The home directory: harness detection, and — at `--scope user` — the root every
   * install path is resolved against. Defaults to the real one; tests pass a temp
   * directory, which is the only way a machine-wide install is testable without
   * rewriting the developer's own `~/.claude/settings.json`.
   */
  readonly home?: string;
  /**
   * Interactive input for the wizards — `init`, `hooks`, `agents split`, `setup` —
   * which read answers line by line, which the one-shot `stdin()` above cannot
   * provide. `bin.ts` passes the real stdin stream; tests pass a scripted one.
   * Absent means a wizard verb is a usage error (or, for setup, that only `--yes`
   * can answer it). See {@link AnswerStream} for why the type is structural.
   */
  readonly initInput?: AnswerStream;
  /**
   * True when stdout is an interactive, colour-honouring terminal and `NO_COLOR` is
   * unset — the lava renderer's only switch. Absent or false, every wizard's bytes
   * are exactly what they have always been; `bin.ts` computes it once.
   */
  readonly color?: boolean;
}

/**
 * The errno codes a write to a stream nobody is reading raises, and `undefined` for
 * every other failure — which is somebody else's bug and must keep travelling.
 *
 * `EPIPE` is the reader closing the pipe (`smelt hooks install | head`). `EINVAL` is
 * a descriptor that is no longer writable in the mode Node is using — what
 * `yes | smelt hooks install` produces: the flooded stdin tears the socketpair down
 * underneath a wizard that is still printing prompts. `ERR_STREAM_DESTROYED` is the
 * same fact raised by the stream layer rather than by the syscall.
 *
 * Both spellings matter, because the two arrive by different routes: a synchronous
 * `write` throw (handled by {@link refusingSink}) and an asynchronous `'error'` event
 * on the stream itself, which no `try`/`catch` around the write can see at all — that
 * one is `bin.ts`'s to listen for, and unheard it is an unhandled `'error'` event,
 * which is a stack trace and a non-zero exit nobody chose.
 */
export function closedSinkCode(error: unknown): string | undefined {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (typeof code !== 'string') return undefined;
  return ['EPIPE', 'EINVAL', 'ERR_STREAM_DESTROYED'].includes(code) ? code : undefined;
}

/**
 * An output sink that **refuses** instead of crashing when nobody is on the other end.
 *
 * A wizard writes its prompts before it reads an answer, so it is the one verb shape
 * that writes into a stream a caller may already have closed. Unwrapped, that write
 * throws past every `catch` in the CLI and the user gets a stack trace and exit 4 —
 * "unexpected internal error — this is a bug" — for the entirely ordinary act of
 * piping a wizard into `head`. Wrapped, it is one line and the usage exit, which is
 * what it always was: a wizard driven by something that is not listening.
 *
 * Only the closed-sink codes are answered; see {@link closedSinkCode}.
 */
export function refusingSink(
  write: (text: string) => void,
  refusal: (why: string) => Error,
): (text: string) => void {
  return (text) => {
    try {
      write(text);
    } catch (error) {
      const code = closedSinkCode(error);
      if (code === undefined) throw error;
      throw refusal(code);
    }
  };
}

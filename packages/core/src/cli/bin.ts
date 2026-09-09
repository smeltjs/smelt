#!/usr/bin/env node
import { readFileSync, readSync } from 'node:fs';
import { isatty } from 'node:tty';
import process from 'node:process';

import { colorAllowed, colorDepth, supportsUnicode } from './lava.ts';
import { closedSinkCode, EXIT, runCli } from './run.ts';

/**
 * The `smelt` binary: the thinnest possible shell around {@link runCli}.
 *
 * Everything decidable lives in `run.ts`, which returns an exit code instead of
 * calling `exit`, so the whole CLI is testable in-process. This file owns only the
 * things that cannot be tested without a real process: the shebang, stdin on fd 0, and
 * the exit code itself. `test/cli-bin.test.ts` spawns the *built* binary for exactly
 * those things — an in-process suite cannot see them.
 *
 * Two deliberate subtleties around fd 0:
 *
 *  - **fd 0 may be non-blocking, and must still be read to EOF.** Two separate ways
 *    that happens in the wild: merely accessing `process.stdin` (even `.isTTY`) makes
 *    Node flip fd 0 into non-blocking mode, and a parent that spawned this process
 *    with piped stdio may hand over a socketpair that was *born* non-blocking. Either
 *    way a one-shot `readFileSync(0)` throws `EAGAIN` whenever the producer is slower
 *    than Node's startup — `(sleep 1; echo hi) | smelt --budget 100` used to die with
 *    an internal error. So: the TTY check is `tty.isatty(0)` (a plain syscall, no
 *    stream initialization), `process.stdin` is only handed over lazily to the one
 *    mode that needs a stream (`init`), and the read itself retries `EAGAIN` with a
 *    synchronous back-off until EOF.
 *  - **A closed output stream is a refusal, not a crash.** Writing to a pipe nobody
 *    reads raises asynchronously, on the stream's own `'error'` event, which no
 *    `try`/`catch` around the write can see — so an unheard one is an unhandled
 *    `'error'`: a stack trace and an exit code nobody chose, for `smelt hooks install
 *    | head` or for answering a wizard with `yes`. The listener below turns it into
 *    one line and the usage exit. It is here rather than in `run.ts` because the
 *    streams are this file's: `runCli` only ever sees the two functions it is handed.
 *  - **Bytes that are not UTF-8 are refused, never mangled.** Decoding invalid bytes
 *    would silently replace them with U+FFFD, and the result would still smelt,
 *    round-trip, and verify — of the wrong bytes. That violates the reversibility
 *    story at its root, so the binary refuses (exit code {@link EXIT.refused}) and
 *    names the first offending byte offset instead.
 */

/** Reading fd 0 synchronously is the whole of "works in a pipe", with no stream plumbing. */
function readStdin(): string {
  if (isatty(0)) {
    process.stderr.write(
      'smelt: no input. Pass a file, or pipe text in:\n' +
        '  smelt src/server.ts --budget 4000\n' +
        '  smelt --budget 4000 --focus TypeError < build.log\n',
    );
    process.exit(EXIT.usage);
  }
  const bytes = readAllOfFd0();
  const offset = firstInvalidUtf8Offset(bytes);
  if (offset !== -1) {
    process.stderr.write(
      `smelt: stdin is not valid UTF-8 — first invalid byte at offset ${String(offset)} ` +
        `(0x${bytes[offset]!.toString(16).padStart(2, '0')}). Decoding it would silently ` +
        `replace bytes with U+FFFD, and the "original" smelt could then reconstruct would ` +
        `not be your original. Refusing instead.\n`,
    );
    process.exit(EXIT.refused);
  }
  return bytes.toString('utf8');
}

/** `Atomics.wait` is the only dependency-free synchronous sleep Node offers. */
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Every byte of fd 0, to EOF, whether the descriptor is blocking (a shell pipe, a
 * redirected file) or non-blocking (a socketpair from a spawning parent). `EAGAIN`
 * means "no bytes yet, not EOF" — wait briefly and try again; only a zero-byte read
 * (or Windows' `EOF` on a closed pipe) ends the loop.
 */
function readAllOfFd0(): Buffer {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(1 << 16);
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'EAGAIN') {
        Atomics.wait(sleeper, 0, 0, 10); // producer not ready — 10ms, then retry
        continue;
      }
      if (code === 'EOF') break; // Windows raises EOF instead of returning 0
      throw error;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks);
}

/**
 * The byte offset where `bytes` stops being well-formed UTF-8, or `-1` when it is
 * well-formed throughout. Implements the WHATWG/Unicode table exactly: continuation
 * ranges tightened for E0/ED/F0/F4 so overlongs, surrogates and > U+10FFFF are
 * invalid — the same sequences `Buffer.prototype.toString` would fold into U+FFFD.
 */
function firstInvalidUtf8Offset(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead <= 0x7f) {
      i += 1;
      continue;
    }
    let length: number;
    let firstLow = 0x80;
    let firstHigh = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      if (lead === 0xe0) firstLow = 0xa0; // overlong
      if (lead === 0xed) firstHigh = 0x9f; // UTF-16 surrogates
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      if (lead === 0xf0) firstLow = 0x90; // overlong
      if (lead === 0xf4) firstHigh = 0x8f; // above U+10FFFF
    } else {
      return i; // a bare continuation byte, or C0/C1/F5–FF — invalid as a lead
    }
    if (i + length > bytes.length) return i; // truncated sequence
    for (let k = 1; k < length; k += 1) {
      const continuation = bytes[i + k]!;
      const low = k === 1 ? firstLow : 0x80;
      const high = k === 1 ? firstHigh : 0xbf;
      if (continuation < low || continuation > high) return i;
    }
    i += length;
  }
  return -1;
}

/** `--version` should agree with the manifest, not with a second copy of the number. */
function packageVersion(): string {
  const manifest = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(manifest) as { version?: string };
  return parsed.version ?? '0.0.0';
}

/** Said once, however many streams break, and never from inside its own handler. */
let sinkRefused = false;

function refuseClosedSink(code: string): void {
  if (sinkRefused) return;
  sinkRefused = true;
  try {
    // Verb-agnostic on purpose: this listener sees every verb, and `smelt big.log
    // --json | head` must not be told about a flag its verb does not own.
    process.stderr.write(
      `smelt: nothing is reading smelt's output (${code}) — refusing rather than ` +
        `writing into a closed stream.\n`,
    );
  } catch {
    // stderr is gone too; the exit code is the whole message.
  }
  process.exit(EXIT.usage);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: unknown) => {
    const code = closedSinkCode(error);
    if (code === undefined) throw error;
    refuseClosedSink(code);
  });
}

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdin: readStdin,
    version: packageVersion(),
    cwd: process.cwd(),
    // Read only by name, and only for a name a config file supplied — see CliIo.env.
    env: process.env,
    // The lava palette's switches, computed once here because this is the only file
    // that may look at the real streams. Piped output, agents and NO_COLOR all mean
    // exactly the bytes smelt has always written; FORCE_COLOR is how a person asks
    // for paint through a pipe. The two streams are asked separately: `smelt big.log
    // --budget 4000 > small.log` puts the payload in a file and leaves the report on
    // a terminal, and that report is the half a person reads.
    color: colorAllowed(process.env, process.stdout.isTTY === true),
    colorErr: colorAllowed(process.env, process.stderr.isTTY === true),
    // How much colour the terminal has, asked once. A capability, not a switch, so it
    // is asked about the *terminal* — either stream being one is enough — while the
    // two booleans above stay per-stream. Without this, `38;2;…` went out
    // unconditionally, and Terminal.app, tmux without -2 and every 16-colour emulator
    // rendered the front door's gradient as garbage.
    depth: colorDepth(process.env, process.stdout.isTTY === true || process.stderr.isTTY === true),
    // A person at both ends — the front door's only switch. `isatty(0)` is the same
    // plain syscall readStdin uses, so nothing here flips fd 0 into non-blocking mode.
    tty: process.stdout.isTTY === true && isatty(0),
    // What the locale said this terminal can draw. See `supportsUnicode`.
    unicode: supportsUnicode(process.env),
    // The wizard verbs (`init`, `hooks`, `agents split`, `setup`) read answers line by
    // line, so they get the stream, not readStdin's one-shot slurp of fd 0. A
    // *getter*, because touching `process.stdin` at all flips fd 0 into non-blocking
    // mode and breaks readStdin's readFileSync(0) for every other mode — only a
    // wizard branch of runCli ever reads this property.
    get initInput() {
      return process.stdin;
    },
  });
} catch (error) {
  process.stderr.write(
    `smelt: unexpected internal error — this is a bug, please report it.\n` +
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = EXIT.unexpected;
}

/**
 * The operations seam: what `smelt` *does*, under every door that asks it to.
 *
 * smelt has two front doors — the `smelt` binary in this package and the
 * `@smeltjs/mcp` server next to it — and they are not two products. They are two
 * conventions for saying the same four things: cut this blob, map this tree, give
 * those bytes back, read the counters. The difference between them is entirely at the
 * edges: one reads argv and writes to two streams and returns an exit code, the other
 * validates a JSON Schema and returns a `CallToolResult`.
 *
 * The middle was duplicated anyway. Both packages had their own copy of *the budget is
 * a positive integer with no default*, *an explicit strategy beats a configured one
 * and `lexical` fills last*, *a tree reader refuses a file*, *read a path or fail
 * naming it*, and *a config decides a store*. Five laws, ten implementations — and the
 * mechanical cause is visible in one line of history: `resolveStoreRun` was never
 * exported, so the package that needed the store law could not import it and wrote its
 * own. A restatement leaked across a package boundary because the seam it needed sat
 * on the wrong side of a barrel.
 *
 * So this module is the seam, below both doors:
 *
 * - **`ops/verbs.ts`** — {@link smeltBlob}, {@link mapTree}, {@link retrieveBytes},
 *   {@link retrieveMany}, {@link readCounters}. The verbs over already-resolved inputs, returning data.
 * - **`ops/inputs.ts`** — the laws an input must satisfy to *be* resolved, each
 *   stating its rule once and taking the caller's naming as an argument.
 *
 * A front door is now an adapter: **parse and resolve, call an op, render.** The CLI
 * subcommand bodies do that with flags, a config file and an exit code; the MCP tools
 * do it with a JSON Schema and a result envelope. What each may still keep is what is
 * genuinely its own — its error type, its exit code, its wording, and any policy it
 * deliberately does not share. (`smelt retrieve` refuses a memory store; the MCP
 * server accepts one and says so when it bites. That divergence is intentional, it is
 * documented on both sides, and it lives in the adapters — never here.)
 */

export {
  budgetFault,
  budgetMalformed,
  budgetRequired,
  openStore,
  readBlob,
  readTree,
  resolveStrategy,
} from './inputs.ts';
export type {
  BudgetFault,
  BudgetNaming,
  ResolvedStrategy,
  Ruling,
  StrategySource,
  TreeNaming,
} from './inputs.ts';
export { mapTree, readCounters, retrieveBytes, retrieveMany, smeltBlob } from './verbs.ts';
export type {
  FocusSource,
  MapTreeOp,
  ReadCountersOp,
  ResolvedFocus,
  RetrieveBytesOp,
  RetrieveManyOp,
  SmeltBlobOp,
  SmeltBlobOutcome,
} from './verbs.ts';

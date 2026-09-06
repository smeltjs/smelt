import facts from '@/generated/facts.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { CopyButton } from '@/components/ui/CopyButton';
import { Reveal } from '@/components/ui/Reveal';

/** Two-tier monochrome highlighting: code in ash, comments in slag. Honest and quiet. */
function Code({ code }: { code: string }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-[8px] border border-iron-dark bg-lift p-4 font-mono text-[12.5px] leading-[1.6]">
      <code>
        {code.split('\n').map((line, i) => {
          const at = line.indexOf('//');
          return (
            <span key={i}>
              {at === -1 ? (
                <span className="text-ash">{line}</span>
              ) : (
                <>
                  <span className="text-ash">{line.slice(0, at)}</span>
                  <span className="text-slag">{line.slice(at)}</span>
                </>
              )}
              {'\n'}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

const STEPS = [
  {
    n: '1',
    title: 'Smelt every tool result',
    note: 'On its way into the context — the persistent store keeps bytes and counters across turns and processes.',
    code: `const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  store: new DirectoryElisionStore('${facts.recipe.storeDir}'),
});

const result = await smelter.smelt(rawToolOutput, {
  path: 'src/server.ts',
  focus: [whatTheModelAskedFor],
  budgetBytes: 4_000,
});
pushToolResult(result.text);`,
  },
  {
    n: '2',
    title: 'Register the way back',
    note: 'smelt_retrieve is a normal tool: hash in, exact original bytes out.',
    code: `const { name, description, inputSchema, invoke } =
  smelter.tool; // 'smelt_retrieve'

tools.push({
  name,
  description,
  input_schema: inputSchema,
});

// in your dispatcher:
// if (call.name === 'smelt_retrieve')
//   return invoke(call.input);`,
  },
  {
    n: '3',
    title: 'Watch the honest signal',
    note: 'Surface expansionRate next to your token counts. 0 means every cut was right; rising means the budget is too aggressive.',
    code: `const s = smelter.stats();

s.expansionRate;  // fraction asked back for
s.retrieveCalls;  // round trips you paid for
s.elisionsStored; // how much smelt hid

s.allElisionsRetrieved;
// true → the cutting saved nothing;
// loosen budgets`,
  },
] as const;

/**
 * The tier table, generated: rows are `harnessesByTier()` over `HARNESS_PROFILES`, with
 * each tier's one line of honesty from `TIER_HONESTY` — see `scripts/facts-data.mjs`.
 * It used to be typed here, which meant a harness promoted from experimental to
 * verified kept its old row until somebody remembered this file existed.
 */
const TIERS = facts.tiers;

/** The MCP registration command is a recipe fact (facts.json), never typed here. */
const MCP_CMD = facts.recipe.mcpRegister;

export function Harness() {
  return (
    <section aria-labelledby="harness" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="harness"
          index="04 · library · hooks · mcp →"
          title={
            <>
              Wiring it into a harness.{' '}
              <span className="text-slag">Three steps, SDK-agnostic.</span>
            </>
          }
          lead={
            <>
              The library is the front door: smelt tool output, register{' '}
              <code className="rounded-[2px] bg-lift px-1 font-mono text-[13px] text-ash">
                smelt_retrieve
              </code>
              , watch the rate. The hooks preset and the MCP server wrap the same loop for harnesses
              you don't own the code of.
            </>
          }
        />

        <Reveal className="mt-10">
          <div className="grid md:grid-cols-3">
            {STEPS.map((step, i) => (
              <div
                key={step.n}
                className={
                  i === 0
                    ? 'py-4 md:py-0 md:pr-8'
                    : 'border-t border-iron-dark py-4 md:border-l md:border-t-0 md:px-8 md:py-0 ' +
                      (i === 2 ? 'md:pr-0' : '')
                }
              >
                <div className="font-mono text-[13px] text-iron-light">step {step.n}</div>
                <h3 className="mt-1 text-[17px] font-medium text-ash sm:text-[18px]">
                  {step.title}
                </h3>
                <p className="mt-2 text-[14px] leading-[1.6] text-slag">{step.note}</p>
                <Code code={step.code} />
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal className="mt-14">
          <h3 className="text-[17px] font-medium text-ash sm:text-[18px]">
            Or let one command do all of it:{' '}
            <code className="rounded-[2px] bg-lift px-1.5 font-mono text-[15px]">
              smelt setup
            </code>
          </h3>
          <p className="mt-2 max-w-[70ch] text-[14px] leading-[1.6] text-slag">
            Config, this whole preset, and the MCP registration — applied together, with a real
            retrieve round trip as the check.{' '}
            <code className="rounded-[2px] bg-lift px-1 font-mono text-[13px] text-ash">
              smelt hooks install
            </code>{' '}
            remains the fine-grained editor (per-file consent, toggle edits), and{' '}
            <code className="rounded-[2px] bg-lift px-1 font-mono text-[13px] text-ash">
              smelt doctor
            </code>{' '}
            reads it all back and names what is behind. Tiered honestly:
          </p>
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
              <thead>
                <tr className="border-b border-iron-dark">
                  <th
                    scope="col"
                    className="py-2.5 pr-6 font-mono text-[13px] font-normal text-slag"
                  >
                    tier
                  </th>
                  <th
                    scope="col"
                    className="py-2.5 pr-6 font-mono text-[13px] font-normal text-slag"
                  >
                    harnesses
                  </th>
                  <th scope="col" className="py-2.5 font-mono text-[13px] font-normal text-slag">
                    what the tier means
                  </th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((row) => (
                  <tr key={row.tier} className="border-b border-iron-dark">
                    <td className="py-3 pr-6 align-top font-mono text-[13px] text-ash">
                      {row.tier}
                    </td>
                    <td className="py-3 pr-6 align-top text-slag">
                      {row.harnesses.map((harness) => harness.label).join(', ')}
                    </td>
                    <td className="py-3 align-top leading-[1.6] text-slag">{row.honesty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal className="mt-14">
          <h3 className="text-[17px] font-medium text-ash sm:text-[18px]">As an MCP server</h3>
          <p className="mt-2 max-w-[70ch] text-[14px] leading-[1.6] text-slag">
            <code className="rounded-[2px] bg-lift px-1 font-mono text-[13px] text-ash">
              @smeltjs/mcp
            </code>{' '}
            serves the same library over stdio — four tools (
            <span className="font-mono text-[13px]">smelt_file</span>,{' '}
            <span className="font-mono text-[13px]">smelt_retrieve</span>,{' '}
            <span className="font-mono text-[13px]">repo_map</span>,{' '}
            <span className="font-mono text-[13px]">smelt_stats</span>) against the same
            config-discovered store the CLI uses, so shell retrievals and tool retrievals move one
            set of counters. The SDK's HTTP transports never enter the import graph —
            guard-enforced.
          </p>
          <div className="mt-4 flex max-w-[560px] items-center gap-3 rounded-[8px] border border-iron-dark bg-lift px-4 py-3">
            <span aria-hidden="true" className="select-none font-mono text-[13px] text-iron-light">
              $
            </span>
            <code className="overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ash">
              {MCP_CMD}
            </code>
            <CopyButton text={MCP_CMD} label="Copy the MCP install command" className="ml-auto" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

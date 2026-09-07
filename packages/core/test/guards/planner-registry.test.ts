import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { cliUsage, parseSmeltArgs } from '@guard/cli/args';
import { parseConfig } from '@guard/cli/config';
import { AUTO_PLANNER_ID } from '@guard/plan/auto';
import { DIFF_PLANNER_ID } from '@guard/plan/diff';
import { JSON_PLANNER_ID } from '@guard/plan/json';
import { LEXICAL_PLANNER_ID } from '@guard/plan/lexical';
import { isStrategy, PLANNERS, STRATEGIES } from '@guard/plan/planners';
import { STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';

import type { GuardMutation } from './_mutations.ts';

/**
 * The PLANNERS registry is the single source of the strategy names: `createSmelter`
 * builds from it, `--strategy` and `smelt.config.json` validation accept its keys, and
 * the help text renders them. This guard restates the shipped set independently, so
 * dropping an entry from the registry goes red on every face at once — factory,
 * validation, and help — instead of one face quietly forgetting a strategy the others
 * still claim.
 */

/** Restated by hand, on purpose: the registry must not be its own witness. */
const SHIPPED: Record<string, string> = {
  lexical: LEXICAL_PLANNER_ID,
  structural: STRUCTURAL_PLANNER_ID,
  auto: AUTO_PLANNER_ID,
  json: JSON_PLANNER_ID,
  diff: DIFF_PLANNER_ID,
};
const SHIPPED_NAMES = Object.keys(SHIPPED).toSorted();

describe('the PLANNERS registry serves every shipped strategy', () => {
  it('carries exactly the shipped names — no more, no fewer', () => {
    expect(Object.keys(PLANNERS).toSorted()).toEqual(SHIPPED_NAMES);
    expect([...STRATEGIES].toSorted()).toEqual(SHIPPED_NAMES);
  });

  it('builds a working planner for each name, with the id that planner advertises', () => {
    for (const [name, id] of Object.entries(SHIPPED)) {
      const factory = PLANNERS[name as keyof typeof PLANNERS];
      expect(factory, name).toBeTypeOf('function');
      const planner = factory({});
      expect(planner.id, name).toBe(id);
      expect(planner.plan, name).toBeTypeOf('function');
    }
  });
});

describe('--strategy validation accepts exactly the registry keys', () => {
  it('accepts every shipped name, through the flag and through isStrategy', () => {
    for (const name of SHIPPED_NAMES) {
      expect(isStrategy(name), name).toBe(true);
      // parseSmeltArgs returns the CliInvocation union; only the 'smelt' arm carries
      // a strategy, so the assertion pins the mode too.
      expect(parseSmeltArgs(['--strategy', name]), name).toMatchObject({
        mode: 'smelt',
        strategy: name,
      });
    }
  });

  it('refuses an unknown name, and the refusal names every shipped strategy', () => {
    expect(() => parseSmeltArgs(['--strategy', 'psychic'])).toThrow(/unknown --strategy/);
    try {
      parseSmeltArgs(['--strategy', 'psychic']);
    } catch (error) {
      for (const name of SHIPPED_NAMES) {
        expect((error as Error).message, name).toContain(name);
      }
    }
    expect(isStrategy('psychic')).toBe(false);
  });
});

describe('smelt.config.json validation accepts exactly the registry keys', () => {
  it('accepts every shipped name', () => {
    for (const name of SHIPPED_NAMES) {
      const config = parseConfig(JSON.stringify({ smeltConfig: 1, strategy: name }), 'x.json');
      expect(config.strategy, name).toBe(name);
    }
  });

  it('refuses an unknown name, and the refusal names every shipped strategy', () => {
    let message = '';
    try {
      parseConfig(JSON.stringify({ smeltConfig: 1, strategy: 'psychic' }), 'x.json');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('"strategy"');
    for (const name of SHIPPED_NAMES) {
      expect(message, name).toContain(`"${name}"`);
    }
  });
});

describe('the help text names every shipped strategy on its --strategy line', () => {
  it('renders each registry key where --strategy is documented', () => {
    const usage = cliUsage();
    for (const name of SHIPPED_NAMES) {
      expect(usage, name).toMatch(new RegExp(`--strategy <id>.*\\b${name}\\b`));
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'planner-registry-entry-dropped',
    file: 'plan/planners.ts',
    find: '  structural: (options: PlannerFactoryOptions): Planner =>\n    new StructuralPlanner(options.structural ?? {}),\n',
    replace: '',
    why: 'a shipped strategy dropped from the one PLANNERS registry — the factory, --strategy and config validation, and the help text all lose it in the same edit, and the guard must watch every face go red together',
  },
];

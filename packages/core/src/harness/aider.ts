import type { HarnessProfile } from './profile.ts';

/**
 * Aider — ADVISORY tier. Instructions only, and honest about it.
 *
 * No usable hook API, so the whole install is the shared snippet in `CONVENTIONS.md`
 * and one caveat: Aider auto-reads no rules file, so the human has to point it at the
 * conventions themselves. Nothing here is enforced, and the installer says so.
 */
export const aider: HarnessProfile = {
  id: 'aider',
  name: 'Aider',
  tier: 'advisory',
  detect: ['.aider.conf.yml'],
  detectHome: ['.aider.conf.yml'],
  // Project-only at user scope: Aider auto-reads no rules file at all (the caveat
  // below), so there is no home-level location to write one to.
  instructionFile: 'CONVENTIONS.md',
  instructions: 'snippet',
  caveats: [
    'Aider auto-reads no rules file: add `read: CONVENTIONS.md` to .aider.conf.yml (or pass --read CONVENTIONS.md) yourself',
  ],
  install: [],
};

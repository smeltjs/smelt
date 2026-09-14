# smelt — keeping the store small

Part of the smelt skill; the root `SKILL.md` covers reading, retrieving and mapping.

Nothing is ever evicted on its own: no timer, no size cap, nothing on opening a store.
Deleting elided bytes is one explicit command, and it refuses unless an age was named —
on the command line or, since 0.8.0, in the config. Plan it first, then run it:

    smelt store prune --older-than 30d --dry-run
    smelt store prune --older-than 30d

Read the dry run before the real one. A pruned hash is gone, and a later
`smelt retrieve` on it refuses and says when it was pruned rather than pretending the
bytes were never there.

The age can be written down instead of retyped, inside the store block of
`smelt.config.json`:

    "store": { "kind": "directory", "path": ".smelt/store",
               "retention": { "olderThan": "30d", "keepRetrieved": true } }

That is a number, not a schedule: nothing prunes because it is there. It supplies the
default age; `--older-than` on the command line overrides it, and the prune report
names which of the two chose the age. A configured `keepRetrieved: true` is added to
`--keep-retrieved`, never overridden by its absence — a flag with no negative spelling
cannot delete more than the config asked to spare. With no age on either the flag or in
the config, the command still refuses.

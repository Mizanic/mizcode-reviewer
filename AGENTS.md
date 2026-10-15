# Agent instructions

## The review skill has a copy in aiman

The owner's skills repo, `rehanhaider/aiman`, carries a built copy of `skills/mizcode-reviewer/`, so `aiman sync` deploys the skill to the owner's machines. This copy is temporary. #38 removes it when the plugin ships.

The skill is built from `skills/mizcode-reviewer/`, `packages/review/` and `packages/server/`. When a PR that changes any of them merges, refresh the copy in the same task:

1. Check out `main` at the merge commit and run `npm ci && npm run build`.
2. Replace aiman's `skills/mizcode-reviewer/` with this repo's `skills/mizcode-reviewer/`, including the built `scripts/lib/`.
3. In aiman, run `npm run check`.
4. Commit to aiman `main` as `chore(mizcode-reviewer): refresh from mizcode-reviewer <short sha>` and push.
5. Tell the owner to run `aiman sync`.

Never edit the copy in aiman directly. Change the skill here, then refresh.

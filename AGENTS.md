# Agent instructions

## The plugin ships the built skill

Claude Code and Codex install the `mizcode-reviewer` plugin straight from this repo: `.claude-plugin/` and `.codex-plugin/` describe it, and the two `marketplace.json` files list it. An install copies the repo as it is in git, so `skills/mizcode-reviewer/scripts/lib/` is committed.

When a change touches `packages/review/` or `packages/server/` code the skill uses, run `npm run build` and commit the rebuilt `skills/mizcode-reviewer/scripts/lib/` in the same PR.

Codex caches the plugin by the `version` in `.codex-plugin/plugin.json`. Raise it when a change should reach Codex users.

OpenCode installs only `skills/mizcode-reviewer/` (`opencode plugin add 'github:Mizanic/mizcode-reviewer#main::path:skills/mizcode-reviewer'`). Its `package.json` points OpenCode at `scripts/opencode.js`. Keep `scripts` and `workspaces` out of that `package.json`: npm builds a git dependency whose `package.json` has workspaces or an install, build, prepack or prepare script, and that step fails inside OpenCode.

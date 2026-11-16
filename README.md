# mizcode-reviewer

mizcode-reviewer lets your AI coding tool, Claude Code or Codex, post its pull request reviews as `mizcode-reviewer[bot]` instead of under your own GitHub account.

## How it works

1. Your AI tool runs the `mizcode-reviewer` skill. The skill's script, `review.js gather`, reads the pull request with your own GitHub sign-in and stages it in a temporary directory.
2. The skill asks the mizcode-reviewer server, through its MCP tool `check_repo`, whether `mizcode-reviewer[bot]` is installed on the repository and you can write to it. If not, the skill stops before reviewing and shows the install link or the reason.
3. Your AI tool writes the review on your machine, with your own AI subscription.
4. The skill sends the review to the server through its MCP tool, `submit_review`, with your GitHub sign-in token.
5. The server asks GitHub whose token it is, and checks again that the bot is installed and you can write to the repository.
6. If the pull request has new commits since the review was written, it posts nothing. Otherwise it posts the review as a comment review from `mizcode-reviewer[bot]`.

The server receives only the repository name and the review you send it. Your token stays on your machine.

## Install

You need Node.js 22 or later and git. If you install Node.js after the plugin, restart your AI tool so the plugin can use it.

Claude Code, 2.1.292 or later:

```sh
claude plugin install mizcode-reviewer --marketplace Mizanic/mizcode-reviewer
```

Codex:

```sh
codex plugin marketplace add Mizanic/mizcode-reviewer
codex plugin add mizcode-reviewer@mizcode-reviewer
```

The plugin adds the review skill and the connection to the server. Start a new session after you install it.

Then install the bot on the repositories you want reviewed: https://github.com/apps/mizcode-reviewer/installations/new

In an organization, a repository admin can install the bot on the repositories they administer, unless the organization allows only owners to install apps. Other members see Request instead of Install: GitHub emails the organization's owners, and reviews post once an owner installs it. Until then the skill stops before reviewing and shows the install link.

## Use

Ask your AI tool to review a pull request, for example `/mizcode-reviewer 42`.

The first time, the skill shows a code. Open https://github.com/login/device on any device and enter it. The sign-in is saved in `~/.config/mizcode-reviewer/token.json` on your machine, and later reviews skip this step.

To update in Claude Code, refresh the marketplace first. `claude plugin update` alone reports the installed version as the latest:

```sh
claude plugin marketplace update mizcode-reviewer
claude plugin update mizcode-reviewer@mizcode-reviewer
```

To update in Codex:

```sh
codex plugin marketplace upgrade mizcode-reviewer
```

Then start a new session.

## Uninstall

Claude Code:

```sh
claude plugin uninstall mizcode-reviewer@mizcode-reviewer
claude plugin marketplace remove mizcode-reviewer
```

Codex:

```sh
codex plugin remove mizcode-reviewer@mizcode-reviewer
codex plugin marketplace remove mizcode-reviewer
```

The plugin's sign-in stays on your machine and on GitHub until you remove it:

1. Delete `~/.config/mizcode-reviewer/token.json`.
2. On GitHub, open Settings, then Applications, then the Authorized GitHub Apps tab, and revoke mizcode-reviewer. This ends every token issued to it for you.

The bot stays installed on your repositories. To remove it, uninstall it under Settings, then Applications, then Installed GitHub Apps, or in the organization's Settings under GitHub Apps. Other people on the repository who use mizcode-reviewer lose the bot too.

## The review skill

`skills/mizcode-reviewer/` holds the review method, [SKILL.md](skills/mizcode-reviewer/SKILL.md), and the script it runs:

```sh
node <skill>/scripts/review.js login [--wait]
node <skill>/scripts/review.js gather <pr> [--repo <owner/name>]
node <skill>/scripts/review.js post --workdir <dir> --findings-file <file> [--suspicions-file <file>] --signed-by <label> --dry-run
node <skill>/scripts/review.js cleanup --workdir <dir>
```

[packages/review/README.md](packages/review/README.md) is the command contract: every flag, the workdir files, the JSON output and the exit codes.

`skills/mizcode-reviewer/scripts/lib/` is built from `packages/` and committed, so the plugin runs without `npm install`. After changing `packages/review` or `packages/server`, run `npm run build` and commit the result.

## post-review

`packages/server/` also holds `post-review`, a standalone command that posts one review file as the App. The skill does not use it. The build writes it to `packages/server/dist/cli.js`, and it runs from the clone:

```sh
node packages/server/dist/cli.js --app-id <id> --key-file <path> --repo <owner/name> --pr <number> --sha <commit> --review <review.json>
```

`--sha` is the full commit SHA the review was written against. review.json holds the review:

```json
{
  "body": "Markdown summary",
  "comments": [
    { "path": "src/app.ts", "line": 120, "side": "RIGHT", "start_line": 115, "start_side": "RIGHT", "body": "Markdown comment" }
  ]
}
```

`comments` can be empty. `start_line` and `start_side` are optional and only used for comments on more than one line. The review is always a comment review; it never approves or requests changes.

On success, `post-review` prints `{ "review_id": 123, "html_url": "https://github.com/...#pullrequestreview-123" }` and exits 0. If the App already posted a review at `--sha` with the same body and the same inline comments, `post-review` posts nothing and prints that review's ID and URL. On failure, it prints `{ "error": "...", "message": "..." }` to stderr. The message says what to do next.

| error | When | Exit code | Extra fields |
|---|---|---|---|
| `bad_input` | Bad flags, a missing or invalid key file, or an invalid review.json | 2 | |
| `not_installed` | The App is not installed on the repository | 1 | |
| `github_error` | GitHub refused the request or could not be reached | 1 | `status`, when GitHub answered |
| `head_moved` | The pull request head is not `--sha` | 3 | `current_head` |

## Status

Early development.

## License

[FSL-1.1-ALv2](LICENSE.md)

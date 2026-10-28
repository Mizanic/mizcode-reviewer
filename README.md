# mizcode-reviewer

mizcode-reviewer lets your AI coding tool (Claude Code or Codex) post its pull request reviews as a bot, for example `acme-review[bot]`, instead of under your own GitHub account.

## How it works

1. Your AI tool runs the `mizcode-reviewer` skill. The skill's script, `review.js gather`, reads the pull request as your GitHub App and stages it in a temporary directory.
2. Your AI tool writes the review on your machine, with your own AI subscription.
3. `review.js post` signs in to GitHub as your GitHub App with the App's private key, which stays on your machine.
4. If the pull request has new commits since the review was written, it posts nothing and exits with code 3.
5. Otherwise it posts the review as a comment review from the bot.

There is no server. Your machine talks to GitHub directly.

## Install

You need Node.js 22 or later, npm and git. Build the skill from a clone:

```sh
git clone https://github.com/Mizanic/mizcode-reviewer.git
cd mizcode-reviewer
npm ci
npm run build
```

The build writes the script and the GitHub client into `skills/mizcode-reviewer/scripts/lib/`. After that, the `skills/mizcode-reviewer/` folder runs on its own with Node.js 22 or later and git. It needs no `npm install`, no global link, no `node_modules` and no command on the PATH.

Link or copy the folder where your tool looks for skills:

```sh
ln -s "$PWD/skills/mizcode-reviewer" ~/.claude/skills/mizcode-reviewer   # Claude Code
ln -s "$PWD/skills/mizcode-reviewer" ~/.agents/skills/mizcode-reviewer   # Codex
```

Put the App ID in `~/.config/mizcode-reviewer/config.json` as `{ "app_id": <id> }`, with the private key beside it as `app.pem`. Then run `/mizcode-reviewer <pr>` in your tool.

To update, run `git pull`, `npm ci` and `npm run build` in the clone again. A copied folder needs copying again.

## The review skill

`skills/mizcode-reviewer/` holds the review method, [SKILL.md](skills/mizcode-reviewer/SKILL.md), and the script it runs:

```sh
node <skill>/scripts/review.js gather <pr> [--repo <owner/name>]
node <skill>/scripts/review.js post --workdir <dir> --findings-file <file> [--suspicions-file <file>] --signed-by <label> [--dry-run]
node <skill>/scripts/review.js cleanup --workdir <dir>
```

[packages/review/README.md](packages/review/README.md) is the command contract: every flag, the workdir files, the JSON output and the exit codes.

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

## Your own GitHub App

[docs/run-your-own-bot.md](docs/run-your-own-bot.md) is the guide: register the App, save its private key, install it on your repositories and install the skill. [docs/github-app-manifest.json](docs/github-app-manifest.json) lists the permissions the App needs: pull requests read and write, and metadata read.

## License

[FSL-1.1-ALv2](LICENSE.md)

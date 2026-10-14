# mizcode-reviewer

mizcode-reviewer lets your AI coding tool (Claude Code or Codex) post its pull request reviews as a bot, for example `acme-review[bot]`, instead of under your own GitHub account.

## How it works

1. Your AI tool writes the review on your machine, with your own AI subscription.
2. It saves the review to a file and runs the `post-review` command.
3. `post-review` signs in to GitHub as your GitHub App with the App's private key, which stays on your machine.
4. If the pull request has new commits since the review was written, it posts nothing and exits with code 3.
5. Otherwise it posts the review as a comment review from the bot.

There is no server. Your machine talks to GitHub directly.

## Install

You need Node.js 22 or later and npm. Install from a clone:

```sh
git clone https://github.com/Mizanic/mizcode-reviewer.git
cd mizcode-reviewer
npm ci
npm run build
npm install --global ./packages/server
```

The last step links the `post-review` executable into npm's global `bin` directory, so it runs from any directory. Its path is `$(npm prefix --global)/bin/post-review`, for example `/usr/local/bin/post-review`. Check it with:

```sh
post-review --help
```

The link points at your clone. To update, run `git pull`, `npm ci` and `npm run build` in the clone again.

## Usage

```sh
post-review --app-id <id> --key-file <path> --repo <owner/name> --pr <number> --sha <commit> --review <review.json>
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

On success, `post-review` prints `{ "review_id": 123, "html_url": "https://github.com/...#pullrequestreview-123" }` and exits 0. On failure, it prints `{ "error": "...", "message": "..." }` to stderr. The message says what to do next.

| error | When | Exit code | Extra fields |
|---|---|---|---|
| `bad_input` | Bad flags, a missing or invalid key file, or an invalid review.json | 2 | |
| `not_installed` | The App is not installed on the repository | 1 | |
| `github_error` | GitHub refused the request or could not be reached | 1 | `status`, when GitHub answered |
| `head_moved` | The pull request head is not `--sha` | 3 | `current_head` |

## Status

Early development.

## Your own GitHub App

[docs/github-app-manifest.json](docs/github-app-manifest.json) lists the permissions the App needs: pull requests read and write, and metadata read.

## License

[FSL-1.1-ALv2](LICENSE.md)

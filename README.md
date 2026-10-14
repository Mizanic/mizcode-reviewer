# mizcode-reviewer

mizcode-reviewer lets your AI coding tool (Claude Code or Codex) post its pull request reviews as a bot, for example `acme-review[bot]`, instead of under your own GitHub account.

## How it works

1. Your AI tool writes the review on your machine, with your own AI subscription.
2. It saves the review to a file and runs the `post-review` command.
3. `post-review` signs in to GitHub as your GitHub App with the App's private key, which stays on your machine.
4. If the pull request has new commits since the review was written, it posts nothing and exits with code 3.
5. Otherwise it posts the review as a comment review from the bot.

There is no server. Your machine talks to GitHub directly.

## Status

Early development. `post-review` is not written yet.

## Your own GitHub App

[docs/github-app-manifest.json](docs/github-app-manifest.json) lists the permissions the App needs: pull requests read and write, and metadata read.

## License

[FSL-1.1-ALv2](LICENSE.md)

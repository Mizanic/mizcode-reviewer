# mizcode-review

`mizcode-review` is the command the [pr-review skill](../../skills/pr-review/SKILL.md) runs. It reads a pull request as your GitHub App and stages it for review. It never uses `gh` and never acts as you.

This README is the command contract. Another runtime, for example a Python version for machines without Node.js, can implement the same commands by following it: the same subcommands, flags, workdir files, JSON output and exit codes.

## Install

You need Node.js 22 or later, npm and git. From a clone of this repository:

```sh
npm ci
npm run build
npm install --global ./packages/review
```

The last step links `mizcode-review` into npm's global `bin` directory, `$(npm prefix --global)/bin`. The link points at your clone. To update, run `git pull`, `npm ci` and `npm run build` in the clone again.

## Settings

`~/.config/mizcode-reviewer/config.json`:

```json
{ "app_id": 5312457, "key_file": "~/.config/mizcode-reviewer/app.pem" }
```

| Field | Required | Meaning |
|---|---|---|
| `app_id` | yes | The App's numeric ID, as a number or a string |
| `key_file` | no | The App's private key, the `.pem` file from the App's settings page. Default: `app.pem` in the same directory. A path that starts with `~/` is in your home directory; any other relative path is relative to `~/.config/mizcode-reviewer` |

Any other field is `bad_input`.

## Output and errors

Every command prints its result to stdout and exits 0. On failure it prints one JSON object to stderr and nothing to stdout:

```json
{ "error": "not_installed", "message": "The App is not installed on acme/widgets. Install it on that repository and try again." }
```

The message says what to do next.

| error | When | Exit code | Extra fields |
|---|---|---|---|
| `bad_input` | Bad flags, an unknown command, an invalid `config.json`, a missing or invalid key file, or a workdir without a valid `state.json` | 2 | |
| `not_configured` | `config.json` does not exist or has no `app_id` | 4 | |
| `not_installed` | The App is not installed on the repository | 1 | |
| `github_error` | GitHub refused a request or could not be reached | 1 | `status`, when GitHub answered |
| `git_error` | `git worktree remove` failed | 1 | |

`mizcode-review --help` and `mizcode-review <command> --help` print usage and exit 0.

## gather

```sh
mizcode-review gather <pr> [--repo <owner/name>]
```

| Flag | Meaning |
|---|---|
| `<pr>` | The pull request number, for example `36` or `#36` |
| `--repo <owner/name>` | The repository. Default: the `origin` remote of the git clone in the current directory, which must be a `github.com` URL |

gather signs in as the App with the settings above and gets an installation token limited to the one repository. With it, it reads the pull request, its files, its diff and its review threads. It then makes a new temporary directory, the workdir, named `mizcode-review-<pr>-<random>` in the system temp directory, and writes:

| File | Content |
|---|---|
| `state.json` | `{ "repo", "pr", "head_sha", "base", "url", "workdir", "worktree", "repo_root" }`. `worktree` and `repo_root` are paths or `null` |
| `diff.patch` | The pull request's diff against its base, as GitHub returns it. Absent when GitHub refuses the diff, for example when it is too large |
| `threads.json` | An array of the existing review threads: `{ "path", "line", "is_resolved", "is_outdated", "author", "excerpt", "comment_count" }`. `line` and `author` can be `null`. `excerpt` is the first 300 characters, counted as Unicode code points, of the thread's first comment. `comment_count` is the thread's number of comments |
| `pr_body.md` | The pull request description, empty when there is none |
| `head/` | A detached git worktree at the head commit. Only when the current directory is in a git clone with a remote whose URL ends in `/<owner>/<name>`, with or without `.git` |

To make `head/`, gather runs `git fetch --quiet <remote> pull/<pr>/head` in the clone, then `git worktree add --detach <workdir>/head <head_sha>`. If the head commit cannot be checked out, it uses `FETCH_HEAD` and adds a note. It never changes the clone's checkout or branches.

On success, gather prints this JSON object, indented by two spaces, followed by a newline:

```json
{
  "repo": "Mizanic/mizcode-reviewer",
  "pr": 36,
  "title": "test: live checks for post-review (do not merge)",
  "url": "https://github.com/Mizanic/mizcode-reviewer/pull/36",
  "base": "main",
  "head_sha": "1e43c532b81527f0c71614b8220c3ea8436710d9",
  "changed_files": 1,
  "additions": 13,
  "deletions": 0,
  "files": [{ "path": "test-pr/sample.md", "additions": 13, "deletions": 0 }],
  "threads_open": 2,
  "threads_resolved": 0,
  "workdir": "/tmp/mizcode-review-36-AbC123",
  "diff": "/tmp/mizcode-review-36-AbC123/diff.patch",
  "threads": "/tmp/mizcode-review-36-AbC123/threads.json",
  "pr_body": "/tmp/mizcode-review-36-AbC123/pr_body.md",
  "worktree": "/tmp/mizcode-review-36-AbC123/head",
  "notes": []
}
```

`diff` and `worktree` are `null` when that file was not made. `notes` lists, in plain text, everything gather could not do and why:

| Note | Cause |
|---|---|
| `could not fetch the diff (<reason>); read files individually` | GitHub refused the diff or could not be reached |
| `could not fetch review threads (<reason>); existing-thread dedup may be incomplete` | The threads query failed. `threads.json` holds the pages read before the failure |
| `not inside a git repo; run gather from a clone of the repository to get head/` | The current directory is not in a git repository |
| `no git remote here matches <owner/name>; run gather from a clone of the repository to get head/` | No remote of the clone is the pull request's repository |
| `git fetch <remote> pull/<pr>/head failed: <reason>` | The fetch failed |
| `worktree is at FETCH_HEAD, which may differ from recorded head <first 10 characters of head_sha>` | The head commit could not be checked out, so the fetched commit was used |
| `could not create worktree: <reason>` | `git worktree add` failed |

A note is not an error: gather still exits 0. Every error in the error table stops gather before it makes the workdir.

GitHub requests, all with the installation token:

1. `GET /repos/{owner}/{repo}/pulls/{pr}`
2. `GET /repos/{owner}/{repo}/pulls/{pr}/files?per_page=100&page={n}`, until a page has fewer than 100 files
3. `GET /repos/{owner}/{repo}/pulls/{pr}` with `Accept: application/vnd.github.diff`
4. `POST /graphql` with the `reviewThreads` query, 100 threads a page, until `hasNextPage` is false

## cleanup

```sh
mizcode-review cleanup --workdir <dir>
```

| Flag | Meaning |
|---|---|
| `--workdir <dir>` | The workdir gather printed |

cleanup reads `state.json` and removes the worktree with `git worktree remove`, run in `repo_root`. The workdir and its other files stay. It prints one line of JSON:

| Output | Meaning |
|---|---|
| `{"worktree": "<path>", "result": "removed"}` | The worktree was removed |
| `{"worktree": "<path>", "result": "already_gone"}` | The directory was already gone; `git worktree prune` removed its entry |
| `{"worktree": null, "result": "none"}` | gather made no worktree |

`git worktree remove` refuses a worktree with changed files. cleanup then fails with `git_error` and leaves the worktree in place.

# review.js

`review.js` is the script the [mizcode-reviewer skill](../../skills/mizcode-reviewer/SKILL.md) runs, as `node <skill>/scripts/review.js <command>`. It reads a pull request as your GitHub App, stages it for review, and posts the review as the App. It never uses `gh` and never acts as you. Its `agent` command can have Cursor or OpenCode read the diff instead of your AI tool. When gather made no `head/`, the prompt tells Cursor to read files with `gh api`, as you.

This README is the command contract. Another runtime, for example a Python version for machines without Node.js, can implement the same commands by following it: the same subcommands, flags, workdir files, JSON output and exit codes.

## Build

`npm run build` at the repository root compiles this package and the GitHub client it uses into `skills/mizcode-reviewer/scripts/lib/`. After that, the `skills/mizcode-reviewer/` folder runs on its own with Node.js 22 or later and git. It needs no `npm install`, no global link and no `node_modules`.

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

Every command prints its result to stdout and exits 0. On failure it prints one JSON object to stderr and nothing to stdout, and `post` posts nothing:

```json
{ "error": "not_installed", "message": "The App is not installed on acme/widgets. Install it on that repository and try again." }
```

The message says what to do next.

| error | When | Exit code | Extra fields |
|---|---|---|---|
| `bad_input` | Bad flags, an unknown command, an invalid `config.json`, a missing or invalid key file, a workdir without a valid `state.json`, invalid findings or suspicions, or a finding anchored outside the diff | 2 | |
| `not_configured` | `config.json` does not exist or has no `app_id` | 4 | |
| `not_installed` | The App is not installed on the repository | 1 | |
| `github_error` | GitHub refused a request or could not be reached | 1 | `status`, when GitHub answered |
| `git_error` | `git worktree remove` failed | 1 | |
| `agent_error` | `agent` only: the tool is not on PATH, exited non-zero, ran past `--timeout`, or printed a reply that is not a review in the format `post` reads | 1 | |
| `head_moved` | `post` only: the pull request head is no longer `head_sha` in `state.json` | 3 | `current_head` |
| `review_incomplete` | `agent` only: the tool ran and replied that it could not finish the review | 5 | |

`review.js --help` and `review.js <command> --help` print usage and exit 0.

## gather

```sh
review.js gather <pr> [--repo <owner/name>]
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

## agent

```sh
review.js agent <cursor|opencode> --workdir <dir> [--model <id>] [--variant <effort>] [--method-file <file>] [--timeout <seconds>] [--print-prompt]
```

| Flag | Meaning |
|---|---|
| `cursor` or `opencode` | The tool that reads the diff: Cursor's agent, `cursor-agent`, or OpenCode, `opencode`. It must be on PATH and signed in |
| `--workdir <dir>` | The workdir gather printed |
| `--model <id>` | The model. Default: `auto` for cursor, which lets Cursor pick, and `opencode/deepseek-v4.1-flash-free` for opencode |
| `--variant <effort>` | opencode only: the reasoning effort. Default: `max` |
| `--method-file <file>` | The review method. Default: the skill's `SKILL.md` |
| `--timeout <seconds>` | How long the tool may run. Default: `1800` |
| `--print-prompt` | Print the prompt and stop. Runs no tool and changes no file |

agent has a different model review the code than the one that wrote it. It reads `state.json` from the workdir and builds one prompt: the method file in full, then how this run differs from it, then the output contract. The tool reads the diff, the workdir files and the repository, and replies with one JSON object, `{"findings": [...], "suspicions": [...]}` or `{"error": "<what stopped it>"}`. agent never posts.

The tool runs in `worktree`, or `repo_root` when gather made no worktree, or the current directory. `PWD` is set to that directory too, because opencode reads its directory from `PWD`. It runs read-only:

| Tool | How it runs |
|---|---|
| cursor | `cursor-agent --model <id> --mode ask --trust --print --output-format json --workspace <dir>`, with `--add-dir <workdir>` when the workdir is outside the workspace. Ask mode cannot edit files |
| opencode | `opencode run --standalone --model <id>#<effort> --format json`, with a permission config in `OPENCODE_CONFIG_CONTENT` and `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so an `opencode.json` in the pull request cannot add to the config. It denies edits, web access and every path outside the workspace and the workdir. It allows only the shell commands a review reads with, `git log`, `git show`, `rg` and `cat` among them, each as the exact command or followed by a space, and denies every other command instead of asking. It denies `gh` entirely, because a pattern cannot keep a write or another host out of a `gh api` command, so opencode needs gather's `head/`: without it, agent refuses with `bad_input` |

agent takes the review object from the last fenced JSON block in the tool's final message, then from the first opening fence to the last closing one, then from the whole message. An `error` that is not `null` ends the run with `review_incomplete`, whatever else the object holds. It changes the case of `severity`, `side` and `start_side` to upper case, turns a `line` or `start_line` given as a string of digits into a number, and drops a `line`, `start_line`, `side` or `start_side` that is `null`. Then it runs `post`'s checks on every row, and on the anchors of the P0, P1 and P2 findings against `diff.patch` when the workdir has one. A row or an anchor they refuse fails the run with `agent_error`, so the files it writes always pass them.

Before anything else, unless `--print-prompt` is given, agent deletes `findings.json` and `suspicions.json` from the workdir. On success it writes both, each a JSON array, so `[]` means the tool finished the review and found nothing. It writes `suspicions.json` first and removes both if either write fails. On any failure it leaves neither, so a failed run cannot be posted as an all-clear.

On success, agent prints this JSON object, indented by two spaces, followed by a newline:

```json
{
  "repo": "Mizanic/mizcode-reviewer",
  "pr": 36,
  "head_sha": "1e43c532b81527f0c71614b8220c3ea8436710d9",
  "tool": "opencode",
  "model": "opencode/deepseek-v4.1-flash-free",
  "variant": "max",
  "findings_file": "/tmp/mizcode-review-36-AbC123/findings.json",
  "suspicions_file": "/tmp/mizcode-review-36-AbC123/suspicions.json",
  "findings_count": 1,
  "suspicions_count": 0,
  "signed_by": "OpenCode/Deepseek-V4.1-Flash"
}
```

`variant` is there only for opencode. `signed_by` is the label to pass to `post --signed-by`: the tool's name and the model, without the vendor or provider prefix, the `-free` tier, or the effort and speed suffixes Cursor puts in its model IDs. `auto` gives `Cursor/Auto`, and `gpt-5.6-sol-xhigh` gives `Cursor/GPT-5.6-Sol`.

## post

```sh
review.js post --workdir <dir> --findings-file <file> [--suspicions-file <file>] --signed-by <label> [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--workdir <dir>` | The workdir gather printed. post reads `repo`, `pr` and `head_sha` from its `state.json`, and the diff from its `diff.patch` |
| `--findings-file <file>` | The findings, a JSON array. `[]` posts the all-clear review |
| `--suspicions-file <file>` | Optional. Severe candidates that could not be proved, a JSON array |
| `--signed-by <label>` | Who read the diff, as harness/model, for example `Claude/Opus-5`. One line |
| `--dry-run` | Print the review and post nothing. Needs no settings and makes no GitHub request |

A relative path is relative to the current directory.

A finding:

| Field | Required | Rule |
|---|---|---|
| `path` | yes | Non-empty string |
| `severity` | yes | `P0`, `P1`, `P2` or `P3` |
| `title` | yes | Non-empty string, at most 120 characters after trimming |
| `body` | yes | Non-empty string, at most 120 words |
| `line` | no | Positive integer. Without it the finding goes into the summary, not inline |
| `side` | no | `LEFT` or `RIGHT`. Default `RIGHT` |
| `start_line` | no | Positive integer, less than `line`, for a comment on more than one line. Needs `line` |
| `start_side` | no | `LEFT` or `RIGHT`. Default: `side` |

A suspicion has `path`, `consequence` and `check`, each a non-empty string, and an optional positive integer `line`. Other fields in either file are ignored. post reports every invalid row in one `bad_input` message, numbered from 0 as in the file.

post then:

1. Drops P3 findings. P0, P1 and P2 are posted.
2. Makes each finding with a `line` an inline comment, ordered P0 to P2. Its body is the badge and the title in bold, a blank line, then the finding's body:
   `**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  <title>**`. Badge colours: P0 `red`, P1 `orange`, P2 `yellow`.
3. Checks every inline anchor, `line` on `side` and `start_line` on `start_side`, against `diff.patch`. GitHub accepts a comment on an added or context line on `RIGHT`, in new-file numbering, and on a deleted or context line on `LEFT`, in old-file numbering. One bad anchor fails the whole review, so post refuses with `bad_input` and names the nearest commentable line. When the workdir has no `diff.patch`, post skips this check, and GitHub refuses a bad anchor with `github_error` status 422.
4. Renders the summary, the review body. `<sha>` is the first 10 characters of `head_sha`:

   ```markdown
   > [!NOTE]
   > 🤖 Reviewed by <label>

   <verdict line>

   <!-- rehanhaider/pr-review-skill -->
   ```

   | Posted findings | Suspicions | Verdict line |
   |---|---|---|
   | none | none | ``Reviewed `<sha>` — no new issues found.`` |
   | none | n | ``Reviewed `<sha>` — no findings, <n> unverified.`` |
   | n | any | ``Reviewed `<sha>` — <n> finding(s) (<count per severity, e.g. 1 P0, 2 P2>).`` |

   Findings without a `line` follow the verdict line under `Findings without a line:`, each as `` - `<path>` `` with the badge and title, then its body indented by two spaces. Suspicions follow under `Unverified — severe if real, could not be proved:`, each as ``- `<path>:<line>` — <consequence> Check: <check>``. The all-clear sentence and the hidden marker are what forge's watcher matches. Keep both byte-for-byte.

With `--dry-run`, post prints the review as JSON, indented by two spaces, and stops:

```json
{
  "commit_id": "<head_sha>",
  "event": "COMMENT",
  "body": "<the summary>",
  "comments": [{ "path": "src/app.ts", "line": 3, "side": "RIGHT", "body": "<the comment>" }]
}
```

Otherwise post signs in as the App with the settings above, gets an installation token limited to the one repository, and checks the pull request head. If the head is not `head_sha`, it posts nothing and fails with `head_moved`: review the new head and post again. Then it lists the App's reviews on the pull request. If one is at `head_sha` with the same body and the same inline comments, it posts nothing and prints that review's URL, so running post again after a lost reply does not post every comment twice. Otherwise it posts the review, always a COMMENT review: it never approves or requests changes. On success it prints the review's URL and a newline:

```text
https://github.com/Mizanic/mizcode-reviewer/pull/36#pullrequestreview-123
```

GitHub requests after sign-in:

1. `GET /repos/{owner}/{repo}/pulls/{pr}` with the installation token
2. `GET /app` with the App JWT, for the App's login, `<slug>[bot]`
3. `GET /repos/{owner}/{repo}/pulls/{pr}/reviews` with the installation token, every page
4. `GET /repos/{owner}/{repo}/pulls/{pr}/comments` with the installation token, every page, only when one of the App's reviews is at `head_sha` with the same body
5. `POST /repos/{owner}/{repo}/pulls/{pr}/reviews` with `commit_id`, `body`, `event` and `comments`, only when no review matched

## cleanup

```sh
review.js cleanup --workdir <dir>
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

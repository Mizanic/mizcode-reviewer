// review.js gather: read the PR as the App and stage what the review
// needs in a new temp workdir. The files and the JSON printed match the
// Python pr-review gather.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  GitHubClientError,
  ReviewThreadsError,
  createRepoToken,
  getPullRequest,
  getPullRequestDiff,
  getReviewThreads,
  listPullRequestFiles,
  type Repo,
  type ReviewThread,
} from "../../server/src/index.js";
import { BadInput, loadConfig } from "./config.js";
import { makeWorktree, originRepo } from "./git.js";
import type { RunOptions } from "./review.js";

const OPTIONS = {
  repo: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export const GATHER_USAGE = `Usage: review.js gather <pr> [--repo <owner/name>]

Reads the pull request, its diff, its body and its review threads as the
GitHub App, and stages them in a new temp workdir. When run from a clone of
the repository, also makes a detached worktree of the PR head at head/.

Options:
  --repo <owner/name>  The repository. Default: origin of the clone in the
                       current directory
  -h, --help           Show this help
`;

function withoutPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

// The first 300 characters, counted as code points like Python's slice.
function excerpt(text: string): string {
  return Array.from(text).slice(0, 300).join("");
}

function threadRow(thread: ReviewThread) {
  return {
    path: thread.path,
    line: thread.line,
    is_resolved: thread.isResolved,
    is_outdated: thread.isOutdated,
    author: thread.author,
    excerpt: excerpt(thread.body),
    comment_count: thread.commentCount,
  };
}

// fetch throws without an HTTP status when GitHub cannot be reached; the
// cause says why.
function errorText(error: unknown): string {
  const cause = (error as Error & { cause?: Error }).cause;
  const text = error instanceof GitHubClientError ? error.message : (cause?.message ?? (error as Error).message);
  return withoutPeriod(text).slice(0, 200);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function readArgs(argv: string[], cwd: string): Promise<{ help: true } | { repo: Repo; pullNumber: number }> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    throw new BadInput(`${withoutPeriod((error as Error).message)}. Run review.js gather --help for usage.`);
  }
  if (parsed.values.help) return { help: true };

  if (parsed.positionals.length !== 1) {
    throw new BadInput("Give exactly one pull request number. Run review.js gather --help for usage.");
  }
  const pr = parsed.positionals[0] as string;
  const pullNumber = Number(pr.replace(/^#/, ""));
  if (!/^#?[1-9]\d*$/.test(pr) || !Number.isSafeInteger(pullNumber)) {
    throw new BadInput(`<pr> must be a pull request number, not "${pr}".`);
  }

  const name = parsed.values.repo ?? (await originRepo(cwd));
  if (name === undefined) {
    throw new BadInput("Pass --repo owner/name, or run inside a clone whose origin remote is on github.com.");
  }
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(name);
  if (!match) throw new BadInput(`--repo must be owner/name, not "${name}".`);
  return { repo: { owner: match[1] as string, name: match[2] as string }, pullNumber };
}

// Returns the text to print: the usage, or the gather result as JSON.
export async function gather(argv: string[], options: RunOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const args = await readArgs(argv, cwd);
  if ("help" in args) return GATHER_USAGE;
  const { repo, pullNumber } = args;
  const repoName = `${repo.owner}/${repo.name}`;

  const config = await loadConfig(options.home);
  const token = await createRepoToken(config.appId, config.privateKey, repo, options);
  const pull = await getPullRequest(repo, pullNumber, token, options);
  const files = await listPullRequestFiles(repo, pullNumber, token, options);

  const workdir = await mkdtemp(join(options.tmpdir ?? tmpdir(), `mizcode-review-${pullNumber}-`));
  const notes: string[] = [];

  let diffFile: string | null = null;
  try {
    const diff = await getPullRequestDiff(repo, pullNumber, token, options);
    diffFile = join(workdir, "diff.patch");
    await writeFile(diffFile, diff, "utf8");
  } catch (error) {
    notes.push(`could not fetch the diff (${errorText(error)}); read files individually`);
  }

  await writeFile(join(workdir, "pr_body.md"), pull.body, "utf8");

  let threads: ReviewThread[];
  try {
    threads = await getReviewThreads(repo, pullNumber, token, options);
  } catch (error) {
    threads = error instanceof ReviewThreadsError ? error.threads : [];
    notes.push(`could not fetch review threads (${errorText(error)}); existing-thread dedup may be incomplete`);
  }
  const threadRows = threads.map(threadRow);
  const threadsFile = join(workdir, "threads.json");
  await writeFile(threadsFile, json(threadRows), "utf8");

  const made = await makeWorktree(repoName, pullNumber, pull.headSha, workdir, cwd);
  if (made.note) notes.push(made.note);

  const state = {
    repo: repoName,
    pr: pullNumber,
    head_sha: pull.headSha,
    base: pull.base,
    url: pull.url,
    workdir,
    worktree: made.worktree,
    repo_root: made.repoRoot,
  };
  await writeFile(join(workdir, "state.json"), json(state), "utf8");

  return `${json({
    repo: repoName,
    pr: pullNumber,
    title: pull.title,
    url: pull.url,
    base: pull.base,
    head_sha: pull.headSha,
    changed_files: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    files,
    threads_open: threadRows.filter((t) => !t.is_resolved).length,
    threads_resolved: threadRows.filter((t) => t.is_resolved).length,
    workdir,
    diff: diffFile,
    threads: threadsFile,
    pr_body: join(workdir, "pr_body.md"),
    worktree: made.worktree,
    notes,
  })}\n`;
}

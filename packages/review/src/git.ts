// Local git for gather and cleanup: the repo of the current clone, and a
// detached worktree of the PR head that never touches the user's checkout.

import { execFile } from "node:child_process";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      // A missing git binary or cwd has no exit code. Report it as a failure.
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || error.message });
    });
  });
}

function short(text: string): string {
  return text.trim().slice(0, 200);
}

// owner/name from a github.com remote URL: https, ssh or scp-style, with or
// without .git.
export function githubRepoFromUrl(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

// The repo of the clone in cwd, from origin as configured, before any
// insteadOf rewrite.
export async function originRepo(cwd: string): Promise<string | undefined> {
  const result = await git(["config", "--get", "remote.origin.url"], cwd);
  return result.code === 0 ? githubRepoFromUrl(result.stdout) : undefined;
}

// True if a git remote URL points at owner/name (ssh or https, with or
// without .git).
export function urlMatches(url: string, repo: string): boolean {
  let normalized = url.toLowerCase();
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  return normalized.replaceAll(":", "/").endsWith(`/${repo.toLowerCase()}`);
}

async function matchingRemote(repo: string, cwd: string): Promise<string | undefined> {
  const result = await git(["remote", "-v"], cwd);
  if (result.code !== 0) return undefined;
  for (const line of result.stdout.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && urlMatches(parts[1] as string, repo)) return parts[0];
  }
  return undefined;
}

export interface Worktree {
  worktree: string | null;
  repoRoot: string | null;
  note: string | null;
}

// A detached worktree of the PR head at <workdir>/head, made from the clone in
// cwd when one of its remotes is the PR's repo. Otherwise a note says why not.
export async function makeWorktree(
  repo: string,
  pullNumber: number,
  headSha: string,
  workdir: string,
  cwd: string,
): Promise<Worktree> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) {
    return {
      worktree: null,
      repoRoot: null,
      note: "not inside a git repo; run gather from a clone of the repository to get head/",
    };
  }
  const root = top.stdout.trim();
  const remote = await matchingRemote(repo, cwd);
  if (!remote) {
    return {
      worktree: null,
      repoRoot: root,
      note: `no git remote here matches ${repo}; run gather from a clone of the repository to get head/`,
    };
  }
  const fetched = await git(["fetch", "--quiet", remote, `pull/${pullNumber}/head`], cwd);
  if (fetched.code !== 0) {
    return {
      worktree: null,
      repoRoot: root,
      note: `git fetch ${remote} pull/${pullNumber}/head failed: ${short(fetched.stderr)}`,
    };
  }
  const path = join(workdir, "head");
  const added = await git(["worktree", "add", "--detach", path, headSha], cwd);
  if (added.code === 0) return { worktree: path, repoRoot: root, note: null };
  const fallback = await git(["worktree", "add", "--detach", path, "FETCH_HEAD"], cwd);
  if (fallback.code === 0) {
    return {
      worktree: path,
      repoRoot: root,
      note: `worktree is at FETCH_HEAD, which may differ from recorded head ${headSha.slice(0, 10)}`,
    };
  }
  return { worktree: null, repoRoot: root, note: `could not create worktree: ${short(added.stderr)}` };
}

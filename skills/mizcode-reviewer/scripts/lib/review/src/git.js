// Local git for gather and cleanup: the repo of the current clone, and a
// detached worktree of the PR head that never touches the user's checkout.
import { execFile } from "node:child_process";
import { join } from "node:path";
export function git(args, cwd) {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (!error)
                return resolve({ code: 0, stdout, stderr });
            // A missing git binary or cwd has no exit code. Report it as a failure.
            const code = typeof error.code === "number" ? error.code : 1;
            resolve({ code, stdout: stdout ?? "", stderr: stderr || error.message });
        });
    });
}
function short(text) {
    return text.trim().slice(0, 200);
}
// owner/name from a github.com remote URL: https, ssh or scp-style, with or
// without .git.
export function githubRepoFromUrl(url) {
    const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
    return match ? `${match[1]}/${match[2]}` : undefined;
}
// The repo of the clone in cwd, from origin as configured, before any
// insteadOf rewrite.
export async function originRepo(cwd) {
    const result = await git(["config", "--get", "remote.origin.url"], cwd);
    return result.code === 0 ? githubRepoFromUrl(result.stdout) : undefined;
}
// True if a git remote URL points at owner/name (ssh or https, with or
// without .git).
export function urlMatches(url, repo) {
    let normalized = url.toLowerCase();
    if (normalized.endsWith(".git"))
        normalized = normalized.slice(0, -4);
    return normalized.replaceAll(":", "/").endsWith(`/${repo.toLowerCase()}`);
}
async function matchingRemote(repo, cwd) {
    const result = await git(["remote", "-v"], cwd);
    if (result.code !== 0)
        return undefined;
    for (const line of result.stdout.split("\n")) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && urlMatches(parts[1], repo))
            return parts[0];
    }
    return undefined;
}
// A detached worktree of the PR head at <workdir>/head, made from the clone in
// cwd when one of its remotes is the PR's repo. Otherwise a note says why not.
export async function makeWorktree(repo, pullNumber, headSha, workdir, cwd) {
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
    if (added.code === 0)
        return { worktree: path, repoRoot: root, note: null };
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
// The PR diff built in the PR head worktree when GitHub will not serve it (a
// private repo whose App cannot read contents): the head against its merge
// base with the base branch fetched from the PR's remote. The options pin what
// GitHub's diff media type shows, whatever the user's git config says, so
// post's anchor check reads it the same way.
export async function localDiff(repo, base, worktree, cwd) {
    const remote = await matchingRemote(repo, cwd);
    if (!remote)
        return { note: `no git remote here matches ${repo}` };
    const fetched = await git(["fetch", "--quiet", remote, `refs/heads/${base}`], cwd);
    if (fetched.code !== 0)
        return { note: `git fetch ${remote} ${base} failed: ${short(fetched.stderr)}` };
    const baseSha = await git(["rev-parse", "FETCH_HEAD"], cwd);
    if (baseSha.code !== 0)
        return { note: `could not read the fetched ${base}: ${short(baseSha.stderr)}` };
    const diff = await git([
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.noprefix=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
        "--find-renames",
        "--diff-algorithm=myers",
        `${baseSha.stdout.trim()}...HEAD`,
    ], worktree);
    if (diff.code !== 0)
        return { note: `git diff against ${base} failed: ${short(diff.stderr)}` };
    return { diff: diff.stdout };
}

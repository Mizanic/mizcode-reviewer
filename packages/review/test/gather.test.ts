import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { home, mockGitHub, newDir, run, sh } from "./helpers.js";

const sha = "a".repeat(40);

// A home directory signed in to the shared bot, with a token that never expires.
function signedIn(): string {
  return home({ "token.json": JSON.stringify({ access_token: "ghu_user" }) });
}

function pull(headSha = sha) {
  return {
    status: 200,
    body: {
      number: 7,
      title: "Add widgets",
      body: "Closes #3\n\n## Scope\n\nIn scope:\n- widgets",
      html_url: "https://github.com/acme/widgets/pull/7",
      base: { ref: "main" },
      head: { sha: headSha },
      changed_files: 2,
      additions: 12,
      deletions: 3,
    },
  };
}

const files = {
  status: 200,
  body: [
    { filename: "src/app.ts", additions: 10, deletions: 3, status: "modified" },
    { filename: "README.md", additions: 2, deletions: 0, status: "modified" },
  ],
};
const diffText = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n";
const diff = { status: 200, body: diffText };

function threadNode(path: string, resolved: boolean, body = "Fix this", login: string | null = "reviewer[bot]") {
  return {
    isResolved: resolved,
    isOutdated: false,
    path,
    line: 4,
    comments: { totalCount: 2, nodes: [{ author: login === null ? null : { login }, body }] },
  };
}

function threadsPage(nodes: unknown[], endCursor: string | null = null) {
  return {
    status: 200,
    body: {
      data: {
        repository: {
          pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
        },
      },
    },
  };
}

const threads = threadsPage([threadNode("src/app.ts", false), threadNode("README.md", true)]);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Runs gather outside any git repo, so no worktree is attempted.
async function gather(argv: string[], responses: Array<{ status: number; body: unknown }>, homeDir = signedIn()) {
  const github = mockGitHub(responses);
  const cwd = newDir("not-a-repo");
  const result = await run(["gather", ...argv], { ...github.options, home: homeDir, cwd, tmpdir: newDir("tmp") });
  return { ...result, calls: github.calls, output: result.code === 0 ? (JSON.parse(result.stdout) as Record<string, unknown>) : {} };
}

describe("gather", () => {
  it("reads the PR as the signed-in user and stages the same files and JSON as the Python gather", async () => {
    const { code, stdout, stderr, calls, output } = await gather(["7", "--repo", "acme/widgets"], [
      pull(),
      files,
      diff,
      threads,
    ]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const workdir = String(output.workdir);
    expect(output).toEqual({
      repo: "acme/widgets",
      pr: 7,
      title: "Add widgets",
      url: "https://github.com/acme/widgets/pull/7",
      base: "main",
      head_sha: sha,
      changed_files: 2,
      additions: 12,
      deletions: 3,
      files: [
        { path: "src/app.ts", additions: 10, deletions: 3 },
        { path: "README.md", additions: 2, deletions: 0 },
      ],
      threads_open: 1,
      threads_resolved: 1,
      workdir,
      diff: join(workdir, "diff.patch"),
      threads: join(workdir, "threads.json"),
      pr_body: join(workdir, "pr_body.md"),
      worktree: null,
      notes: ["not inside a git repo; run gather from a clone of the repository to get head/"],
    });
    expect(stdout).toBe(`${JSON.stringify(output, null, 2)}\n`);

    expect(readFileSync(join(workdir, "diff.patch"), "utf8")).toBe(diffText);
    expect(readFileSync(join(workdir, "pr_body.md"), "utf8")).toBe(pull().body.body);
    expect(readJson(join(workdir, "threads.json"))).toEqual([
      {
        path: "src/app.ts",
        line: 4,
        is_resolved: false,
        is_outdated: false,
        author: "reviewer[bot]",
        excerpt: "Fix this",
        comment_count: 2,
      },
      {
        path: "README.md",
        line: 4,
        is_resolved: true,
        is_outdated: false,
        author: "reviewer[bot]",
        excerpt: "Fix this",
        comment_count: 2,
      },
    ]);
    expect(readJson(join(workdir, "state.json"))).toEqual({
      repo: "acme/widgets",
      pr: 7,
      head_sha: sha,
      base: "main",
      url: "https://github.com/acme/widgets/pull/7",
      workdir,
      worktree: null,
      repo_root: null,
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "GET https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=1",
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "POST https://api.github.com/graphql",
    ]);
    const reads = calls;
    for (const read of reads) expect(read.headers.Authorization).toBe("Bearer ghu_user");
    expect(reads[2]?.headers.Accept).toBe("application/vnd.github.diff");
    expect(reads[3]?.body).toMatchObject({ variables: { owner: "acme", name: "widgets", number: 7, cursor: null } });
    expect(String((reads[3]?.body as { query: string }).query)).toContain("reviewThreads(first: 100, after: $cursor)");
  });

  it("accepts #7 and writes an empty pr_body.md when the PR has no body", async () => {
    const noBody = pull();
    noBody.body.body = null as unknown as string;
    const { code, output } = await gather(["#7", "--repo", "acme/widgets"], [noBody, files, diff, threads]);

    expect(code).toBe(0);
    expect(output.pr).toBe(7);
    expect(readFileSync(String(output.pr_body), "utf8")).toBe("");
  });

  it("reads every page of files and threads", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
    const { code, calls, output } = await gather(["7", "--repo", "acme/widgets"], [
      pull(),
      { status: 200, body: page1 },
      { status: 200, body: [{ filename: "last.ts", additions: 1, deletions: 1 }] },
      diff,
      threadsPage([threadNode("a.ts", false)], "CURSOR1"),
      threadsPage([threadNode("b.ts", true)]),
    ]);

    expect(code).toBe(0);
    expect((output.files as unknown[]).length).toBe(101);
    expect(calls[2]?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=2");
    expect(calls[5]?.body).toMatchObject({ variables: { cursor: "CURSOR1" } });
    expect(output.threads_open).toBe(1);
    expect(output.threads_resolved).toBe(1);
  });

  it("cuts a thread excerpt to 300 characters, counting code points", async () => {
    const long = "é".repeat(150) + "😀".repeat(200);
    const { output } = await gather(["7", "--repo", "acme/widgets"], [
      pull(),
      files,
      diff,
      threadsPage([threadNode("a.ts", false, long, null)]),
    ]);

    const [row] = readJson(String(output.threads)) as Array<{ excerpt: string; author: string | null }>;
    expect(row?.excerpt).toBe("é".repeat(150) + "😀".repeat(150));
    expect(row?.author).toBeNull();
  });

  it("notes a failed diff and still stages the rest", async () => {
    const { code, output } = await gather(["7", "--repo", "acme/widgets"], [
      pull(),
      files,
      { status: 406, body: { message: "Sorry, the diff exceeded the maximum number of files (300)." } },
      threads,
    ]);

    expect(code).toBe(0);
    expect(output.diff).toBeNull();
    expect(existsSync(join(String(output.workdir), "diff.patch"))).toBe(false);
    expect(output.notes).toContainEqual(
      "could not fetch the diff (GitHub returned 406: Sorry, the diff exceeded the maximum number of files (300)) or build it locally (no head/ worktree); read files individually",
    );
  });

  it("notes failed threads and keeps the pages read before the failure", async () => {
    const { code, output } = await gather(["7", "--repo", "acme/widgets"], [
      pull(),
      files,
      diff,
      threadsPage([threadNode("a.ts", false)], "CURSOR1"),
      { status: 200, body: { data: null, errors: [{ message: "Something went wrong" }] } },
    ]);

    expect(code).toBe(0);
    expect(readJson(String(output.threads))).toHaveLength(1);
    expect(output.threads_open).toBe(1);
    expect(output.notes).toContainEqual(
      "could not fetch review threads (GitHub GraphQL returned an error: Something went wrong); existing-thread dedup may be incomplete",
    );
  });

  it("notes threads GitHub could not be reached for, keeping the pages read", async () => {
    const github = mockGitHub([pull(), files, diff, threadsPage([threadNode("a.ts", false)], "CURSOR1")]);
    const base = github.options.fetch as typeof fetch;
    let n = 0;
    const result = await run(["gather", "7", "--repo", "acme/widgets"], {
      fetch: async (url, init) => {
        if (++n === 5) throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
        return base(url, init);
      },
      home: signedIn(),
      cwd: newDir("not-a-repo"),
      tmpdir: newDir("tmp"),
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.notes).toContainEqual(
      "could not fetch review threads (Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com); existing-thread dedup may be incomplete",
    );
    expect(readJson(output.threads)).toHaveLength(1);
  });
});

describe("gather in a clone", () => {
  // A bare repo stands in for GitHub: origin says https://github.com/acme/widgets.git
  // and insteadOf points git at the bare repo, which has refs/pull/7/head.
  function clone() {
    const remotes = newDir("remotes");
    const bare = join(remotes, "acme", "widgets.git");
    sh(["init", "--quiet", "--bare", bare], remotes);
    const src = newDir("src");
    sh(["init", "--quiet"], src);
    writeFileSync(join(src, "app.ts"), "export const a = 1;\n");
    sh(["add", "app.ts"], src);
    sh(["commit", "--quiet", "-m", "head"], src);
    sh(["push", "--quiet", bare, "HEAD:refs/pull/7/head"], src);
    const headSha = sh(["rev-parse", "HEAD"], src);

    const dir = newDir("clone");
    sh(["init", "--quiet"], dir);
    sh(["remote", "add", "origin", "https://github.com/acme/widgets.git"], dir);
    sh(["config", `url.file://${remotes}/.insteadOf`, "https://github.com/"], dir);
    return { dir, headSha };
  }

  async function gatherIn(cwd: string, argv: string[], headSha: string) {
    const github = mockGitHub([pull(headSha), files, diff, threads]);
    const result = await run(["gather", ...argv], { ...github.options, home: signedIn(), cwd, tmpdir: newDir("tmp") });
    return { ...result, calls: github.calls, output: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
  }

  it("takes the repo from origin and makes a detached worktree at the head", async () => {
    const { dir, headSha } = clone();
    const { code, stderr, calls, output } = await gatherIn(dir, ["7"], headSha);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7");
    const worktree = join(String(output.workdir), "head");
    expect(output.worktree).toBe(worktree);
    expect(output.notes).toEqual([]);
    expect(readFileSync(join(worktree, "app.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(sh(["rev-parse", "HEAD"], worktree)).toBe(headSha);
    expect(sh(["status", "--porcelain=v2", "--branch"], worktree)).toContain("# branch.head (detached)");
    expect(readJson(join(String(output.workdir), "state.json"))).toMatchObject({
      worktree,
      repo_root: sh(["rev-parse", "--show-toplevel"], dir),
    });
  });

  it("falls back to FETCH_HEAD with a note when the recorded head is not fetched", async () => {
    const { dir, headSha } = clone();
    const { code, output } = await gatherIn(dir, ["7"], "b".repeat(40));

    expect(code).toBe(0);
    expect(sh(["rev-parse", "HEAD"], String(output.worktree))).toBe(headSha);
    expect(output.notes).toEqual(["worktree is at FETCH_HEAD, which may differ from recorded head bbbbbbbbbb"]);
  });

  it("makes no worktree when no remote matches --repo", async () => {
    const { dir, headSha } = clone();
    const { code, output } = await gatherIn(dir, ["7", "--repo", "acme/other"], headSha);

    expect(code).toBe(0);
    expect(output.worktree).toBeNull();
    expect(output.notes).toEqual(["no git remote here matches acme/other; run gather from a clone of the repository to get head/"]);
    expect(readJson(join(String(output.workdir), "state.json"))).toMatchObject({
      worktree: null,
      repo_root: sh(["rev-parse", "--show-toplevel"], dir),
    });
  });

  it("notes a failed fetch", async () => {
    const { dir, headSha } = clone();
    const { code, output } = await gatherIn(dir, ["8"], headSha);

    expect(code).toBe(0);
    expect(output.worktree).toBeNull();
    expect(output.notes).toEqual([expect.stringMatching(/^git fetch origin pull\/8\/head failed: /)]);
  });
});

describe("gather builds the diff from the clone", () => {
  // GitHub refuses the diff media type to an App without contents access on a
  // private repo, while the PR and its files still read fine.
  const forbidden = { status: 403, body: { message: "Resource not accessible by integration" } };

  // origin has main (the base) and refs/pull/7/head one commit ahead. The
  // clone's own config asks for mnemonic prefixes and the histogram
  // algorithm, which the local diff must override.
  function cloneWithBase() {
    const remotes = newDir("remotes");
    const bare = join(remotes, "acme", "widgets.git");
    sh(["init", "--quiet", "--bare", bare], remotes);
    const src = newDir("src");
    sh(["init", "--quiet"], src);
    writeFileSync(join(src, "app.ts"), "export const a = 1;\n");
    sh(["add", "app.ts"], src);
    sh(["commit", "--quiet", "-m", "base"], src);
    sh(["push", "--quiet", bare, "HEAD:refs/heads/main"], src);
    writeFileSync(join(src, "app.ts"), "export const a = 2;\n");
    sh(["commit", "--quiet", "-am", "head"], src);
    sh(["push", "--quiet", bare, "HEAD:refs/pull/7/head"], src);
    const headSha = sh(["rev-parse", "HEAD"], src);

    const dir = newDir("clone");
    sh(["init", "--quiet"], dir);
    sh(["remote", "add", "origin", "https://github.com/acme/widgets.git"], dir);
    sh(["config", `url.file://${remotes}/.insteadOf`, "https://github.com/"], dir);
    sh(["config", "diff.mnemonicPrefix", "true"], dir);
    sh(["config", "diff.algorithm", "histogram"], dir);
    return { dir, headSha };
  }

  async function gatherIn(cwd: string, headSha: string) {
    const github = mockGitHub([pull(headSha), files, forbidden, threads]);
    const result = await run(["gather", "7"], { ...github.options, home: signedIn(), cwd, tmpdir: newDir("tmp") });
    return { ...result, output: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
  }

  it("writes diff.patch from the head against its base when GitHub refuses the diff", async () => {
    const { dir, headSha } = cloneWithBase();
    const { code, stderr, output } = await gatherIn(dir, headSha);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    const diffFile = join(String(output.workdir), "diff.patch");
    expect(output.diff).toBe(diffFile);
    expect(readFileSync(diffFile, "utf8")).toMatch(
      /^diff --git a\/app\.ts b\/app\.ts\nindex [0-9a-f]+\.\.[0-9a-f]+ 100644\n--- a\/app\.ts\n\+\+\+ b\/app\.ts\n@@ -1 \+1 @@\n-export const a = 1;\n\+export const a = 2;\n$/,
    );
    expect(output.notes).toEqual(["could not fetch the diff (GitHub returned 403: Resource not accessible by integration); built diff.patch from the local clone"]);
  });

  it("notes why it could not build the diff when the base is not on the remote", async () => {
    const remotes = newDir("remotes");
    const bare = join(remotes, "acme", "widgets.git");
    sh(["init", "--quiet", "--bare", bare], remotes);
    const src = newDir("src");
    sh(["init", "--quiet"], src);
    writeFileSync(join(src, "app.ts"), "export const a = 1;\n");
    sh(["add", "app.ts"], src);
    sh(["commit", "--quiet", "-m", "head"], src);
    sh(["push", "--quiet", bare, "HEAD:refs/pull/7/head"], src);
    const headSha = sh(["rev-parse", "HEAD"], src);
    const dir = newDir("clone");
    sh(["init", "--quiet"], dir);
    sh(["remote", "add", "origin", "https://github.com/acme/widgets.git"], dir);
    sh(["config", `url.file://${remotes}/.insteadOf`, "https://github.com/"], dir);

    const { code, output } = await gatherIn(dir, headSha);

    expect(code).toBe(0);
    expect(output.diff).toBeNull();
    expect(existsSync(join(String(output.workdir), "diff.patch"))).toBe(false);
    expect(output.notes).toEqual([
      expect.stringMatching(
        /^could not fetch the diff \(GitHub returned 403: Resource not accessible by integration\) or build it locally \(git fetch origin main failed: .+\); read files individually$/,
      ),
    ]);
  });
});

describe("gather errors", () => {
  async function failure(argv: string[], options: { homeDir?: string; cwd?: string; responses?: Array<{ status: number; body: unknown }> } = {}) {
    const github = mockGitHub(options.responses ?? []);
    const tmp = newDir("tmp");
    const result = await run(["gather", ...argv], {
      ...github.options,
      home: options.homeDir ?? signedIn(),
      cwd: options.cwd ?? newDir("not-a-repo"),
      tmpdir: tmp,
    });
    expect(result.stdout).toBe("");
    return { ...result, calls: github.calls, tmp };
  }

  it.each([
    [[], "Give exactly one pull request number"],
    [["7", "8"], "Give exactly one pull request number"],
    [["seven", "--repo", "acme/widgets"], '<pr> must be a pull request number, not "seven"'],
    [["0", "--repo", "acme/widgets"], "<pr> must be a pull request number"],
    [["7", "--repo", "acme"], '--repo must be owner/name, not "acme"'],
    [["7", "--repo"], "Option '--repo <value>' argument missing"],
    [["7", "--sha", "abc"], "Unknown option '--sha'"],
    [["7"], "Pass --repo owner/name, or run inside a clone whose origin remote is on github.com"],
  ])("rejects %j as bad_input", async (argv, message) => {
    const { code, error, calls } = await failure(argv);

    expect(code).toBe(2);
    expect(error?.error).toBe("bad_input");
    expect(String(error?.message)).toContain(message);
    expect(calls).toHaveLength(0);
  });

  it("rejects an origin that is not on github.com", async () => {
    const cwd = newDir("gitlab-clone");
    sh(["init", "--quiet"], cwd);
    sh(["remote", "add", "origin", "https://gitlab.com/acme/widgets.git"], cwd);
    const { code, error } = await failure(["7"], { cwd });

    expect(code).toBe(2);
    expect(String(error?.message)).toContain("Pass --repo owner/name");
  });

  it("exits 4 with not_signed_in and reads nothing when there is no saved token", async () => {
    const { code, error, calls, tmp } = await failure(["7", "--repo", "acme/widgets"], { homeDir: home({}) });

    expect(code).toBe(4);
    expect(error).toEqual({
      error: "not_signed_in",
      message: "Not signed in to the shared mizcode-reviewer bot. Run review.js login.",
    });
    expect(calls).toHaveLength(0);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("exits 1 with not_installed, the install link and no workdir when GitHub cannot find the PR", async () => {
    const { code, error, tmp } = await failure(["7", "--repo", "acme/widgets"], {
      responses: [{ status: 404, body: { message: "Not Found" } }],
    });

    expect(code).toBe(1);
    expect(error).toEqual({
      error: "not_installed",
      message:
        "Could not read acme/widgets#7. Check the pull request number, and that mizcode-reviewer[bot] is installed on acme/widgets: https://github.com/apps/mizcode-reviewer/installations/new",
    });
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("exits 1 with github_error and the status for any other GitHub failure", async () => {
    const { code, error } = await failure(["7", "--repo", "acme/widgets"], {
      responses: [{ status: 502, body: { message: "Bad Gateway" } }],
    });

    expect(code).toBe(1);
    expect(error).toEqual({
      error: "github_error",
      message: "GitHub returned 502: Bad Gateway. GitHub had a problem. Try again in a few minutes.",
      status: 502,
    });
  });

  it("exits 1 with github_error and no status when GitHub cannot be reached", async () => {
    const result = await run(["gather", "7", "--repo", "acme/widgets"], {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
      },
      home: signedIn(),
      cwd: newDir("not-a-repo"),
      tmpdir: newDir("tmp"),
    });

    expect(result.code).toBe(1);
    expect(result.error).toEqual({
      error: "github_error",
      message:
        "Could not complete the request to GitHub: getaddrinfo ENOTFOUND api.github.com. Check the network connection and run again.",
    });
  });
});

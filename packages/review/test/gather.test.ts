import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { home, mockGitHub, newDir, rsaKey, run, sh, type Call } from "./helpers.js";

const sha = "a".repeat(40);
const installation = { status: 200, body: { id: 99 } };
const token = { status: 201, body: { token: "ghs_installation" } };

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
async function gather(argv: string[], responses: Array<{ status: number; body: unknown }>, homeDir = home()) {
  const github = mockGitHub(responses);
  const cwd = newDir("not-a-repo");
  const result = await run(["gather", ...argv], { ...github.options, home: homeDir, cwd, tmpdir: newDir("tmp") });
  return { ...result, calls: github.calls, output: result.code === 0 ? (JSON.parse(result.stdout) as Record<string, unknown>) : {} };
}

describe("gather", () => {
  it("reads the PR as the App and stages the same files and JSON as the Python gather", async () => {
    const { code, stdout, stderr, calls, output } = await gather(["7", "--repo", "acme/widgets"], [
      installation,
      token,
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
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/99/access_tokens",
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "GET https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=1",
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "POST https://api.github.com/graphql",
    ]);
    const [, mint, ...reads] = calls as [Call, Call, ...Call[]];
    expect(mint.body).toEqual({ repositories: ["widgets"] });
    for (const read of reads) expect(read.headers.Authorization).toBe("Bearer ghs_installation");
    expect(reads[2]?.headers.Accept).toBe("application/vnd.github.diff");
    expect(reads[3]?.body).toMatchObject({ variables: { owner: "acme", name: "widgets", number: 7, cursor: null } });
    expect(String((reads[3]?.body as { query: string }).query)).toContain("reviewThreads(first: 100, after: $cursor)");
  });

  it("accepts #7 and writes an empty pr_body.md when the PR has no body", async () => {
    const noBody = pull();
    noBody.body.body = null as unknown as string;
    const { code, output } = await gather(["#7", "--repo", "acme/widgets"], [installation, token, noBody, files, diff, threads]);

    expect(code).toBe(0);
    expect(output.pr).toBe(7);
    expect(readFileSync(String(output.pr_body), "utf8")).toBe("");
  });

  it("reads every page of files and threads", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
    const { code, calls, output } = await gather(["7", "--repo", "acme/widgets"], [
      installation,
      token,
      pull(),
      { status: 200, body: page1 },
      { status: 200, body: [{ filename: "last.ts", additions: 1, deletions: 1 }] },
      diff,
      threadsPage([threadNode("a.ts", false)], "CURSOR1"),
      threadsPage([threadNode("b.ts", true)]),
    ]);

    expect(code).toBe(0);
    expect((output.files as unknown[]).length).toBe(101);
    expect(calls[4]?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=2");
    expect(calls[7]?.body).toMatchObject({ variables: { cursor: "CURSOR1" } });
    expect(output.threads_open).toBe(1);
    expect(output.threads_resolved).toBe(1);
  });

  it("cuts a thread excerpt to 300 characters, counting code points", async () => {
    const long = "é".repeat(150) + "😀".repeat(200);
    const { output } = await gather(["7", "--repo", "acme/widgets"], [
      installation,
      token,
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
      installation,
      token,
      pull(),
      files,
      { status: 406, body: { message: "Sorry, the diff exceeded the maximum number of files (300)." } },
      threads,
    ]);

    expect(code).toBe(0);
    expect(output.diff).toBeNull();
    expect(existsSync(join(String(output.workdir), "diff.patch"))).toBe(false);
    expect(output.notes).toContainEqual(expect.stringMatching(/^could not fetch the diff \(GitHub returned 406: Sorry, the diff exceeded.*\); read files individually$/));
  });

  it("notes failed threads and keeps the pages read before the failure", async () => {
    const { code, output } = await gather(["7", "--repo", "acme/widgets"], [
      installation,
      token,
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
    const github = mockGitHub([installation, token, pull(), files, diff, threadsPage([threadNode("a.ts", false)], "CURSOR1")]);
    const base = github.options.fetch as typeof fetch;
    let n = 0;
    const result = await run(["gather", "7", "--repo", "acme/widgets"], {
      fetch: async (url, init) => {
        if (++n === 7) throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
        return base(url, init);
      },
      home: home(),
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
    const github = mockGitHub([installation, token, pull(headSha), files, diff, threads]);
    const result = await run(["gather", ...argv], { ...github.options, home: home(), cwd, tmpdir: newDir("tmp") });
    return { ...result, calls: github.calls, output: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
  }

  it("takes the repo from origin and makes a detached worktree at the head", async () => {
    const { dir, headSha } = clone();
    const { code, stderr, calls, output } = await gatherIn(dir, ["7"], headSha);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/installation");
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

describe("gather errors", () => {
  async function failure(argv: string[], options: { homeDir?: string; cwd?: string; responses?: Array<{ status: number; body: unknown }> } = {}) {
    const github = mockGitHub(options.responses ?? []);
    const tmp = newDir("tmp");
    const result = await run(["gather", ...argv], {
      ...github.options,
      home: options.homeDir ?? home(),
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

  it("exits 4 with not_configured when config.json is missing", async () => {
    const { code, error, calls } = await failure(["7", "--repo", "acme/widgets"], { homeDir: home({}) });

    expect(code).toBe(4);
    expect(error?.error).toBe("not_configured");
    expect(String(error?.message)).toContain(join(".config", "mizcode-reviewer", "config.json"));
    expect(calls).toHaveLength(0);
  });

  it("exits 4 with not_configured when config.json has no app_id", async () => {
    const { code, error } = await failure(["7", "--repo", "acme/widgets"], {
      homeDir: home({ "config.json": "{}", "app.pem": rsaKey }),
    });

    expect(code).toBe(4);
    expect(error?.error).toBe("not_configured");
    expect(String(error?.message)).toContain("has no app_id");
  });

  it.each([
    ["not JSON", { "config.json": "{app_id: 1}" }, "is not valid JSON"],
    ["not an object", { "config.json": "[1]" }, "must be a JSON object"],
    ["an unknown field", { "config.json": '{"app_id": 1, "appId": 1}' }, "unknown fields appId"],
    ["a non-numeric app_id", { "config.json": '{"app_id": "abc"}' }, 'must be the App\'s numeric ID, not "abc"'],
    ["a missing key file", { "config.json": '{"app_id": 1}' }, "app.pem does not exist"],
    ["a key file that is not a key", { "config.json": '{"app_id": "1"}', "app.pem": "hello" }, "is not an RSA private key"],
  ])("rejects a config with %s as bad_input", async (_, files, message) => {
    const { code, error, calls } = await failure(["7", "--repo", "acme/widgets"], { homeDir: home(files) });

    expect(code).toBe(2);
    expect(error?.error).toBe("bad_input");
    expect(String(error?.message)).toContain(message);
    expect(calls).toHaveLength(0);
  });

  it("reads key_file relative to the config directory, or from ~/", async () => {
    for (const keyFile of ["keys/my.pem", "~/.config/mizcode-reviewer/keys/my.pem"]) {
      const homeDir = home({ "config.json": JSON.stringify({ app_id: 1, key_file: keyFile }) });
      const keys = join(homeDir, ".config", "mizcode-reviewer", "keys");
      mkdirSync(keys, { recursive: true });
      writeFileSync(join(keys, "my.pem"), rsaKey);
      const { code, error } = await failure(["7", "--repo", "acme/widgets"], {
        homeDir,
        responses: [{ status: 404, body: { message: "Not Found" } }],
      });
      expect(error?.error).toBe("not_installed");
      expect(code).toBe(1);
    }
  });

  it("exits 1 with not_installed and makes no workdir", async () => {
    const { code, error, tmp } = await failure(["7", "--repo", "acme/widgets"], {
      responses: [{ status: 404, body: { message: "Not Found" } }],
    });

    expect(code).toBe(1);
    expect(error).toEqual({ error: "not_installed", message: expect.stringContaining("acme/widgets") });
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("exits 1 with github_error, the status and what to check when the PR is not found", async () => {
    const { code, error } = await failure(["7", "--repo", "acme/widgets"], {
      responses: [installation, token, { status: 404, body: { message: "Not Found" } }],
    });

    expect(code).toBe(1);
    expect(error).toEqual({
      error: "github_error",
      message: "GitHub returned 404: Not Found. Check --repo and the pull request number.",
      status: 404,
    });
  });

  it("exits 1 with github_error and no status when GitHub cannot be reached", async () => {
    const result = await run(["gather", "7", "--repo", "acme/widgets"], {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
      },
      home: home(),
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

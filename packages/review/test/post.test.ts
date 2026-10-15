import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAnchors, parseFindings, parseSuspicions, renderSummary, SIGNATURE, type Finding } from "../src/post.js";
import { home, mockGitHub, newDir, run } from "./helpers.js";

const sha = "1e43c532b81527f0c71614b8220c3ea8436710d9";
const installation = { status: 200, body: { id: 99 } };
const token = { status: 201, body: { token: "ghs_installation" } };
const pull = (headSha = sha) => ({ status: 200, body: { head: { sha: headSha } } });
const app = { status: 200, body: { slug: "mizcode-reviewer" } };
const noReviews = { status: 200, body: [] };
const posted = {
  status: 200,
  body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" },
};

// src/app.ts: new-file lines 1-4 on RIGHT (3 added), old-file lines 1-2 on
// LEFT (2 deleted). gone.ts is deleted: old-file lines 1-2 on LEFT only.
const diffText = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,4 @@",
  "-old one",
  " kept",
  "+new two",
  "+new three",
  "+new four",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "",
].join("\n");

const finding = {
  path: "src/app.ts",
  line: 3,
  severity: "P1",
  title: "Keep tenant scope on the fallback query",
  body: "When the primary lookup misses, this fallback queries by email alone.",
};

function workdir(state: Record<string, unknown> = {}, diff: string | null = diffText): string {
  const dir = newDir("workdir");
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({ repo: "acme/widgets", pr: 7, head_sha: sha, base: "main", workdir: dir, worktree: null, repo_root: null, ...state }),
  );
  if (diff !== null) writeFileSync(join(dir, "diff.patch"), diff);
  return dir;
}

function file(content: unknown): string {
  const path = join(newDir("input"), "data.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

function post(
  findings: unknown,
  { suspicions, dryRun = false, dir = workdir(), homeDir = home(), responses = [] as Array<{ status: number; body: unknown }>, signedBy = "Claude/Opus-5" } = {} as {
    suspicions?: unknown;
    dryRun?: boolean;
    dir?: string;
    homeDir?: string;
    responses?: Array<{ status: number; body: unknown }>;
    signedBy?: string;
  },
) {
  const github = mockGitHub(responses);
  const argv = ["post", "--workdir", dir, "--findings-file", file(findings), "--signed-by", signedBy];
  if (suspicions !== undefined) argv.push("--suspicions-file", file(suspicions));
  if (dryRun) argv.push("--dry-run");
  return { github, result: run(argv, { ...github.options, home: homeDir, cwd: newDir("cwd") }) };
}

async function dryRun(findings: unknown, suspicions?: unknown) {
  const { github, result } = post(findings, { suspicions, dryRun: true });
  const out = await result;
  expect(out.stderr).toBe("");
  expect(out.code).toBe(0);
  expect(github.calls).toEqual([]);
  return JSON.parse(out.stdout) as { commit_id: string; event: string; body: string; comments: Array<Record<string, unknown>> };
}

const row = (overrides: Partial<Finding> = {}): Finding => ({
  index: 0,
  path: "src/app.ts",
  line: 3,
  severity: "P1",
  title: "T",
  body: "B",
  ...overrides,
});

describe("post: finding validation", () => {
  it("accepts a valid finding with every optional field", () => {
    const { findings, errors } = parseFindings([
      { ...finding, line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", extra: "ignored" },
    ]);
    expect(errors).toEqual([]);
    expect(findings[0]).toMatchObject({ index: 0, path: "src/app.ts", line: 4, side: "RIGHT", startLine: 2, startSide: "RIGHT" });
  });

  it("requires an array", () => {
    expect(parseFindings({}).errors).toEqual(["the findings file must be a JSON array"]);
  });

  it.each([
    ["a non-object row", "x", "finding 0: must be an object"],
    ["no path", { ...finding, path: "" }, "finding 0: missing 'path'"],
    ["no severity", { ...finding, severity: undefined }, "finding 0: missing 'severity'"],
    ["no title", { ...finding, title: "  " }, "finding 0: missing 'title'"],
    ["no body", { ...finding, body: 5 }, "finding 0: missing 'body'"],
    ["an unknown severity", { ...finding, severity: "P4" }, "finding 0: severity must be one of P0, P1, P2, P3"],
    ["a title over 120 characters", { ...finding, title: "x".repeat(121) }, "finding 0: 'title' must be at most 120 characters"],
    ["a body over 120 words", { ...finding, body: "word ".repeat(121) }, "finding 0: 'body' must be at most 120 words"],
    ["a non-integer line", { ...finding, line: "3" }, "finding 0: 'line' must be a positive integer"],
    ["a zero line", { ...finding, line: 0 }, "finding 0: 'line' must be a positive integer"],
    ["start_line without line", { ...finding, line: undefined, start_line: 2 }, "finding 0: 'start_line' requires 'line'"],
    ["start_line not before line", { ...finding, start_line: 3 }, "finding 0: 'start_line' must be less than 'line'"],
    ["a non-integer start_line", { ...finding, start_line: 1.5 }, "finding 0: 'start_line' must be a positive integer"],
    ["an unknown side", { ...finding, side: "right" }, `finding 0: 'side' must be "LEFT" or "RIGHT"`],
    ["an unknown start_side", { ...finding, start_line: 2, start_side: "UP" }, `finding 0: 'start_side' must be "LEFT" or "RIGHT"`],
  ])("rejects %s", (_name, value, error) => {
    expect(parseFindings([value]).errors).toEqual([error]);
  });

  it("accepts a title of exactly 120 characters and a body of exactly 120 words", () => {
    expect(parseFindings([{ ...finding, title: "é".repeat(120), body: "word ".repeat(120) }]).errors).toEqual([]);
  });

  it("reports every invalid row, numbered as in the file", () => {
    expect(parseFindings([finding, { ...finding, path: "" }, { ...finding, severity: "P9" }]).errors).toEqual([
      "finding 1: missing 'path'",
      "finding 2: severity must be one of P0, P1, P2, P3",
    ]);
  });
});

describe("post: suspicion validation", () => {
  const suspicion = { path: "src/auth.ts", line: 42, consequence: "Locks out admins.", check: "Log the claim." };

  it("accepts a valid suspicion, with or without a line", () => {
    const noLine = { path: "src/session.ts", consequence: "Leaks a session.", check: "Read the cookie flags." };
    expect(parseSuspicions([suspicion, noLine])).toEqual({ suspicions: [suspicion, noLine], errors: [] });
  });

  it("requires an array", () => {
    expect(parseSuspicions("x").errors).toEqual(["the suspicions file must be a JSON array"]);
  });

  it.each([
    ["a non-object row", 1, "suspicion 0: must be an object"],
    ["no path", { ...suspicion, path: undefined }, "suspicion 0: missing required non-empty 'path'"],
    ["no consequence", { ...suspicion, consequence: " " }, "suspicion 0: missing required non-empty 'consequence'"],
    ["no check", { ...suspicion, check: "" }, "suspicion 0: missing required non-empty 'check'"],
    ["a non-integer line", { ...suspicion, line: "42" }, "suspicion 0: 'line' must be a positive integer"],
  ])("rejects %s", (_name, value, error) => {
    expect(parseSuspicions([value]).errors).toEqual([error]);
  });
});

describe("post: anchor checks", () => {
  it("accepts added and context lines on RIGHT and deleted and context lines on LEFT", () => {
    const anchors = [1, 2, 3, 4].map((line) => row({ line }));
    anchors.push(row({ line: 1, side: "LEFT" }), row({ line: 2, side: "LEFT" }));
    expect(checkAnchors(anchors, diffText)).toEqual([]);
  });

  it("accepts a deleted file's lines on LEFT under its old path", () => {
    expect(checkAnchors([row({ path: "gone.ts", line: 2, side: "LEFT" })], diffText)).toEqual([]);
  });

  it("names a file that is not in the diff", () => {
    expect(checkAnchors([row({ path: "src/other.ts" })], diffText)).toEqual([
      "finding 0 (src/other.ts:3): file is not in the PR diff",
    ]);
  });

  it("names the nearest commentable line on the same side", () => {
    expect(checkAnchors([row({ index: 2, line: 9 }), row({ index: 3, line: 7, side: "LEFT" })], diffText)).toEqual([
      "finding 2 (src/app.ts:9, RIGHT): line is not part of the diff; nearest commentable RIGHT line is 4",
      "finding 3 (src/app.ts:7, LEFT): line is not part of the diff; nearest commentable LEFT line is 2",
    ]);
  });

  it("says when a file has no lines on that side", () => {
    expect(checkAnchors([row({ path: "gone.ts", line: 1 })], diffText)).toEqual([
      "finding 0 (gone.ts:1): no commentable RIGHT lines in this file's hunks",
    ]);
  });

  it("checks start_line on start_side, which defaults to side", () => {
    expect(checkAnchors([row({ line: 2, side: "LEFT", startLine: 1 })], diffText)).toEqual([]);
    expect(checkAnchors([row({ line: 4, startLine: 1, startSide: "LEFT" })], diffText)).toEqual([]);
    expect(checkAnchors([row({ line: 4, startLine: 6, side: "RIGHT" })], diffText)).toEqual([
      "finding 0 (src/app.ts:6, RIGHT): line is not part of the diff; nearest commentable RIGHT line is 4",
    ]);
  });
});

describe("post: summary text", () => {
  it("is the exact all-clear with the reviewer note and the hidden marker when nothing is posted", () => {
    expect(renderSummary(sha, [], [], " Claude/Opus-5 ", [])).toBe(
      "> [!NOTE]\n> 🤖 Reviewed by Claude/Opus-5\n\nReviewed `1e43c532b8` — no new issues found.\n\n<!-- rehanhaider/pr-review-skill -->\n",
    );
    expect(SIGNATURE).toBe("rehanhaider/pr-review-skill");
  });

  it("counts findings by severity, in severity order", () => {
    const body = renderSummary(sha, [row({ severity: "P2" }), row({ severity: "P0" }), row({ severity: "P2" })], [], "Cursor/Auto", []);
    expect(body).toBe(
      "> [!NOTE]\n> 🤖 Reviewed by Cursor/Auto\n\nReviewed `1e43c532b8` — 3 findings (1 P0, 2 P2).\n\n<!-- rehanhaider/pr-review-skill -->\n",
    );
    expect(renderSummary(sha, [row()], [], "Cursor/Auto", [])).toContain("Reviewed `1e43c532b8` — 1 finding (1 P1).\n");
  });

  it("withholds the all-clear while a suspicion is unresolved and lists each one", () => {
    const body = renderSummary(sha, [], [], "Claude/Opus-5", [
      { path: "src/auth.ts", line: 42, consequence: " Locks out every admin. ", check: " Log the raw claim. " },
      { path: "src/session.ts", consequence: "Leaks a session.", check: "Read the cookie flags." },
    ]);
    expect(body).not.toContain("no new issues found");
    expect(body).toBe(
      [
        "> [!NOTE]",
        "> 🤖 Reviewed by Claude/Opus-5",
        "",
        "Reviewed `1e43c532b8` — no findings, 2 unverified.",
        "",
        "Unverified — severe if real, could not be proved:",
        "",
        "- `src/auth.ts:42` — Locks out every admin. Check: Log the raw claim.",
        "- `src/session.ts` — Leaks a session. Check: Read the cookie flags.",
        "",
        "<!-- rehanhaider/pr-review-skill -->",
        "",
      ].join("\n"),
    );
  });

  it("puts findings without a line in the summary, with their body", () => {
    const summary = [row({ line: undefined, path: "README.md", severity: "P2", title: "Fix the install step", body: "Line one.\nLine two." })];
    const body = renderSummary(sha, summary, summary, "Claude/Opus-5", []);
    expect(body).toBe(
      [
        "> [!NOTE]",
        "> 🤖 Reviewed by Claude/Opus-5",
        "",
        "Reviewed `1e43c532b8` — 1 finding (1 P2).",
        "",
        "Findings without a line:",
        "",
        "- `README.md` **<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Fix the install step**",
        "",
        "  Line one.",
        "  Line two.",
        "",
        "<!-- rehanhaider/pr-review-skill -->",
        "",
      ].join("\n"),
    );
  });
});

describe("post: dry run", () => {
  it("prints the all-clear review for no findings and calls nothing", async () => {
    const review = await dryRun([]);
    expect(review).toEqual({
      commit_id: sha,
      event: "COMMENT",
      body: "> [!NOTE]\n> 🤖 Reviewed by Claude/Opus-5\n\nReviewed `1e43c532b8` — no new issues found.\n\n<!-- rehanhaider/pr-review-skill -->\n",
      comments: [],
    });
  });

  it("renders inline comments with badges, ordered by severity, and drops P3", async () => {
    const review = await dryRun([
      { ...finding, severity: "P2", line: 4, title: "Second", body: " Two. " },
      { ...finding, severity: "P3", title: "Low" },
      { ...finding, severity: "P0", line: 2, side: "LEFT", start_line: 1, title: "First", body: "One." },
    ]);
    expect(review.comments).toEqual([
      {
        path: "src/app.ts",
        line: 2,
        side: "LEFT",
        start_line: 1,
        start_side: "LEFT",
        body: "**<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)</sub></sub>  First**\n\nOne.",
      },
      {
        path: "src/app.ts",
        line: 4,
        side: "RIGHT",
        body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Second**\n\nTwo.",
      },
    ]);
    expect(review.body).toContain("Reviewed `1e43c532b8` — 2 findings (1 P0, 1 P2).\n");
    expect(review.body).not.toContain("Low");
  });

  it("posts the all-clear when only P3 findings survive", async () => {
    const review = await dryRun([{ ...finding, severity: "P3" }]);
    expect(review.comments).toEqual([]);
    expect(review.body).toContain("Reviewed `1e43c532b8` — no new issues found.\n");
  });

  it("renders suspicions under the summary", async () => {
    const review = await dryRun([], [{ path: "src/auth.ts", line: 42, consequence: "Locks out admins.", check: "Log the claim." }]);
    expect(review.body).toContain("Reviewed `1e43c532b8` — no findings, 1 unverified.\n");
    expect(review.body).toContain("- `src/auth.ts:42` — Locks out admins. Check: Log the claim.\n");
  });

  it("skips the anchor check when the workdir has no diff.patch", async () => {
    const { github, result } = post([{ ...finding, line: 99 }], { dryRun: true, dir: workdir({}, null) });
    const out = await result;
    expect(out.code).toBe(0);
    expect(github.calls).toEqual([]);
    expect(JSON.parse(out.stdout).comments[0].line).toBe(99);
  });

  it("needs no config file", async () => {
    const { result } = post([], { dryRun: true, homeDir: newDir("empty-home") });
    expect((await result).code).toBe(0);
  });
});

describe("post: posting", () => {
  it("posts a COMMENT review at head_sha as the App and prints the review URL", async () => {
    const { github, result } = post([finding], { responses: [installation, token, pull(), app, noReviews, posted] });
    const out = await result;

    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("https://github.com/acme/widgets/pull/7#pullrequestreview-123\n");
    expect(github.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/99/access_tokens",
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "GET https://api.github.com/app",
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews?per_page=100&page=1",
      "POST https://api.github.com/repos/acme/widgets/pulls/7/reviews",
    ]);
    expect(github.calls[5]?.headers.Authorization).toBe("Bearer ghs_installation");
    expect(github.calls[5]?.body).toEqual({
      commit_id: sha,
      event: "COMMENT",
      body: "> [!NOTE]\n> 🤖 Reviewed by Claude/Opus-5\n\nReviewed `1e43c532b8` — 1 finding (1 P1).\n\n<!-- rehanhaider/pr-review-skill -->\n",
      comments: [
        {
          path: "src/app.ts",
          line: 3,
          side: "RIGHT",
          body: "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Keep tenant scope on the fallback query**\n\nWhen the primary lookup misses, this fallback queries by email alone.",
        },
      ],
    });
  });

  it("prints the URL of the App's identical review at head_sha and posts nothing", async () => {
    const first = post([finding], { responses: [installation, token, pull(), app, noReviews, posted] });
    expect((await first.result).code).toBe(0);
    const sent = first.github.calls.at(-1)?.body as { body: string; comments: Array<{ path: string; line: number; side: string; body: string }> };
    const existing = {
      id: 123,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123",
      user: { login: "mizcode-reviewer[bot]" },
      commit_id: sha,
      body: sent.body,
    };
    const comments = sent.comments.map((c) => ({ ...c, original_line: c.line, original_start_line: null, start_side: null }));

    const { github, result } = post([finding], {
      responses: [installation, token, pull(), app, { status: 200, body: [existing] }, { status: 200, body: comments }],
    });
    const out = await result;

    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("https://github.com/acme/widgets/pull/7#pullrequestreview-123\n");
    expect(github.calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  it("resolves relative paths against the working directory", async () => {
    const cwd = newDir("cwd");
    const dir = join(cwd, "work");
    writeFileSync(join(cwd, "findings.json"), "[]");
    mkdirSync(dir);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ repo: "acme/widgets", pr: 7, head_sha: sha }));
    const github = mockGitHub();
    const out = await run(
      ["post", "--workdir", "work", "--findings-file", "findings.json", "--signed-by", "Claude/Opus-5", "--dry-run"],
      { ...github.options, cwd, home: home() },
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).commit_id).toBe(sha);
  });
});

describe("post: errors", () => {
  it.each([
    ["an unknown flag", ["post", "--event", "APPROVE"], "Unknown option '--event'"],
    ["missing flags", ["post"], "Missing --workdir, --findings-file, --signed-by"],
  ])("exits 2 with bad_input for %s", async (_name, argv, message) => {
    const out = await run(argv, mockGitHub().options);
    expect(out.code).toBe(2);
    expect(out.error?.error).toBe("bad_input");
    expect(out.error?.message).toContain(message);
  });

  it.each([
    ["an empty --signed-by", { signedBy: " " }],
    ["a two-line --signed-by", { signedBy: "Claude/Opus-5\nextra" }],
  ])("exits 2 with bad_input for %s", async (_name, overrides) => {
    const out = await post([], { dryRun: true, ...overrides }).result;
    expect(out.code).toBe(2);
    expect(out.error).toMatchObject({ error: "bad_input", message: expect.stringContaining("--signed-by") });
  });

  it("exits 2 with bad_input for a workdir without state.json", async () => {
    const out = await post([], { dir: newDir("no-state") }).result;
    expect(out.code).toBe(2);
    expect(out.error?.message).toContain("There is no state.json");
  });

  it("exits 2 with bad_input for a state.json without a full head SHA", async () => {
    const out = await post([], { dir: workdir({ head_sha: "abc" }) }).result;
    expect(out.code).toBe(2);
    expect(out.error?.message).toContain("head_sha as a full commit SHA");
  });

  it("exits 2 with bad_input for a missing or malformed findings file", async () => {
    const missing = await run(
      ["post", "--workdir", workdir(), "--findings-file", join(newDir("x"), "nope.json"), "--signed-by", "C/M"],
      mockGitHub().options,
    );
    expect(missing.code).toBe(2);
    expect(missing.error?.message).toContain("does not exist");

    const malformed = await post("[{").result;
    expect(malformed.code).toBe(2);
    expect(malformed.error?.message).toContain("is not valid JSON");
  });

  it("exits 2 with bad_input and every reason for invalid findings, posting nothing", async () => {
    const { github, result } = post([{ ...finding, severity: "P9" }, { ...finding, title: "" }]);
    const out = await result;
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.error?.error).toBe("bad_input");
    expect(out.error?.message).toContain("finding 0: severity must be one of P0, P1, P2, P3; finding 1: missing 'title'");
    expect(github.calls).toEqual([]);
  });

  it("exits 2 with bad_input for invalid suspicions", async () => {
    const out = await post([], { suspicions: [{ path: "a.ts" }] }).result;
    expect(out.code).toBe(2);
    expect(out.error?.message).toContain("suspicion 0: missing required non-empty 'consequence'");
  });

  it("exits 2 with bad_input for a bad anchor, even on a dry run, posting nothing", async () => {
    for (const dryRun of [false, true]) {
      const { github, result } = post([{ ...finding, line: 9 }], { dryRun, responses: [installation, token, pull(), app, noReviews, posted] });
      const out = await result;
      expect(out.code).toBe(2);
      expect(out.error?.error).toBe("bad_input");
      expect(out.error?.message).toContain("nearest commentable RIGHT line is 4");
      expect(github.calls).toEqual([]);
    }
  });

  it("does not check a P3 finding's anchor, since it is never posted", async () => {
    const review = await dryRun([{ ...finding, severity: "P3", line: 99 }]);
    expect(review.comments).toEqual([]);
  });

  it("exits 4 with not_configured when there is no config file", async () => {
    const { github, result } = post([], { homeDir: newDir("empty-home") });
    const out = await result;
    expect(out.code).toBe(4);
    expect(out.error?.error).toBe("not_configured");
    expect(github.calls).toEqual([]);
  });

  it("exits 4 with not_configured when config.json has no app_id", async () => {
    const out = await post([], { homeDir: home({ "config.json": "{}" }) }).result;
    expect(out.code).toBe(4);
    expect(out.error?.error).toBe("not_configured");
  });

  it("exits 1 with not_installed when the App is not on the repo", async () => {
    const out = await post([], { responses: [{ status: 404, body: { message: "Not Found" } }] }).result;
    expect(out.code).toBe(1);
    expect(out.error).toEqual({
      error: "not_installed",
      message: "The App is not installed on acme/widgets. Install it on that repository and try again.",
    });
  });

  it("exits 1 with github_error and the status when GitHub refuses the review", async () => {
    const out = await post([finding], {
      responses: [installation, token, pull(), app, noReviews, { status: 422, body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } }],
    }).result;
    expect(out.code).toBe(1);
    expect(out.error).toEqual({
      error: "github_error",
      status: 422,
      message:
        'GitHub returned 422: Unprocessable Entity: ["Line could not be resolved"]. Check that every finding\'s path and line are in the pull request diff.',
    });
  });

  it("exits 3 with head_moved and current_head when the head moved, posting nothing", async () => {
    const moved = "b".repeat(40);
    const { github, result } = post([finding], { responses: [installation, token, pull(moved)] });
    const out = await result;
    expect(out.code).toBe(3);
    expect(out.stdout).toBe("");
    expect(out.error).toMatchObject({ error: "head_moved", current_head: moved });
    expect(github.calls.some((c) => c.url.endsWith("/reviews"))).toBe(false);
  });
});

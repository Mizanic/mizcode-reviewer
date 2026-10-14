import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ClientOptions } from "../src/github.js";
import { USAGE, runPostReview } from "../src/post-review.js";

const dir = mkdtempSync(join(tmpdir(), "post-review-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const keyFile = file("app.pem", rsaKey);

const sha = "a".repeat(40);
const review = {
  body: "Summary",
  comments: [
    { path: "src/app.ts", line: 120, side: "RIGHT", start_line: 115, start_side: "RIGHT", body: "Multi-line" },
    { path: "src/util.ts", line: 4, side: "RIGHT", body: "Single line" },
  ],
};
const reviewFile = file("review.json", JSON.stringify(review));

const flags = {
  "--app-id": "5312457",
  "--key-file": keyFile,
  "--repo": "acme/widgets",
  "--pr": "7",
  "--sha": sha,
  "--review": reviewFile,
};

function args(overrides: Record<string, string | undefined> = {}): string[] {
  return Object.entries({ ...flags, ...overrides }).flatMap(([flag, value]) =>
    value === undefined ? [] : [flag, value],
  );
}

function reviewWith(content: unknown): string[] {
  return args({ "--review": file(`review-${Math.random()}.json`, JSON.stringify(content)) });
}

// Answers each request with the next queued response and records the request.
function mockGitHub(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const options: ClientOptions = {
    fetch: async (url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${String(url)}`);
      const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      return new Response(text, { status: next.status });
    },
  };
  return { calls, options };
}

async function run(argv: string[], options: ClientOptions = mockGitHub().options) {
  let stdout = "";
  let stderr = "";
  const code = await runPostReview(
    argv,
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    options,
  );
  return { code, stdout, stderr, error: stderr ? (JSON.parse(stderr) as Record<string, unknown>) : undefined };
}

async function badInput(argv: string[]) {
  const github = mockGitHub();
  const result = await run(argv, github.options);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.error?.error).toBe("bad_input");
  expect(github.calls).toHaveLength(0);
  return String(result.error?.message);
}

const installation = { status: 200, body: { id: 99 } };
const token = { status: 201, body: { token: "ghs_installation" } };
const pull = { status: 200, body: { head: { sha } } };
const posted = {
  status: 200,
  body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" },
};

describe("post-review", () => {
  it("prints usage for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await run([flag]);
      expect(result).toMatchObject({ code: 0, stdout: USAGE, stderr: "" });
    }
  });

  it("posts the review and prints its ID and URL", async () => {
    const github = mockGitHub([installation, token, pull, posted]);

    const result = await run(args(), github.options);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      review_id: 123,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123",
    });
    expect(github.calls.at(-1)).toEqual({
      method: "POST",
      url: "https://api.github.com/repos/acme/widgets/pulls/7/reviews",
      body: { commit_id: sha, body: "Summary", event: "COMMENT", comments: review.comments },
    });
  });

  it("accepts an uppercase SHA and posts it in lowercase", async () => {
    const github = mockGitHub([installation, token, pull, posted]);

    const result = await run(args({ "--sha": sha.toUpperCase() }), github.options);

    expect(result.code).toBe(0);
    expect((github.calls.at(-1)?.body as { commit_id: string }).commit_id).toBe(sha);
  });

  it("accepts an empty comments array", async () => {
    const github = mockGitHub([installation, token, pull, posted]);

    const result = await run(reviewWith({ body: "All clear", comments: [] }), github.options);

    expect(result.code).toBe(0);
    expect(github.calls.at(-1)?.body).toMatchObject({ body: "All clear", comments: [] });
  });
});

describe("post-review argument errors", () => {
  it("rejects an unknown flag", async () => {
    expect(await badInput([...args(), "--event", "APPROVE"])).toContain("--event");
  });

  it("rejects a positional argument", async () => {
    expect(await badInput([...args(), "extra"])).toContain("extra");
  });

  it("rejects a flag with no value", async () => {
    expect(await badInput([...args({ "--sha": undefined }), "--sha"])).toContain("--sha");
  });

  it("names every missing flag", async () => {
    const message = await badInput(args({ "--app-id": undefined, "--sha": undefined }));
    expect(message).toContain("Missing --app-id, --sha");
    expect(message).toContain("--help");
  });

  it("rejects an empty flag value as missing", async () => {
    expect(await badInput(args({ "--repo": "" }))).toContain("Missing --repo");
  });

  it.each([
    ["--app-id", "mizcode-reviewer"],
    ["--app-id", "0"],
    ["--repo", "widgets"],
    ["--repo", "acme/widgets/extra"],
    ["--pr", "seven"],
    ["--pr", "0"],
    ["--pr", "-1"],
    ["--pr", "99999999999999999999"],
    ["--sha", "abc1234"],
    ["--sha", "z".repeat(40)],
  ])("rejects %s %s", async (flag, value) => {
    expect(await badInput(args({ [flag]: value }))).toContain(flag);
  });
});

describe("post-review config errors", () => {
  it("rejects a missing key file", async () => {
    const path = join(dir, "missing.pem");
    const message = await badInput(args({ "--key-file": path }));
    expect(message).toContain(path);
    expect(message).toContain("does not exist");
  });

  it("rejects a key file that is not a private key", async () => {
    const path = file("not-a-key.pem", "hello");
    expect(await badInput(args({ "--key-file": path }))).toContain("not an RSA private key");
  });

  it("rejects a private key that is not RSA", async () => {
    const ecKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const path = file("ec.pem", ecKey);
    expect(await badInput(args({ "--key-file": path }))).toContain("not an RSA private key");
  });

  it("rejects a missing review file", async () => {
    expect(await badInput(args({ "--review": join(dir, "missing.json") }))).toContain("does not exist");
  });

  it("rejects a review file that is not JSON", async () => {
    const path = file("broken.json", "{ body: ");
    expect(await badInput(args({ "--review": path }))).toContain("not valid JSON");
  });

  it.each([
    ["an array", [], "JSON object"],
    ["no body", { comments: [] }, "body must be a non-empty string"],
    ["an empty body", { body: " ", comments: [] }, "body must be a non-empty string"],
    ["no comments", { body: "x" }, "comments must be an array"],
    ["an event field", { body: "x", comments: [], event: "APPROVE" }, "unknown fields event"],
    ["a comment that is not an object", { body: "x", comments: ["hi"] }, "comments[0] must be an object"],
    [
      "a comment with no path",
      { body: "x", comments: [{ line: 1, side: "RIGHT", body: "c" }] },
      "comments[0].path",
    ],
    [
      "a comment with a fractional line",
      { body: "x", comments: [{ path: "a", line: 1.5, side: "RIGHT", body: "c" }] },
      "comments[0].line",
    ],
    [
      "a comment with a lowercase side",
      { body: "x", comments: [{ path: "a", line: 1, side: "right", body: "c" }] },
      "comments[0].side",
    ],
    [
      "a comment with no body",
      { body: "x", comments: [{ path: "a", line: 1, side: "RIGHT" }] },
      "comments[0].body",
    ],
    [
      "a comment with a string start_line",
      { body: "x", comments: [{ path: "a", line: 2, side: "RIGHT", start_line: "1", body: "c" }] },
      "comments[0].start_line",
    ],
    [
      "a comment with start_side but no start_line",
      { body: "x", comments: [{ path: "a", line: 2, side: "RIGHT", start_side: "RIGHT", body: "c" }] },
      "comments[0].start_side needs start_line",
    ],
    [
      "a comment with an unknown field",
      { body: "x", comments: [{ path: "a", line: 1, side: "RIGHT", body: "c", position: 3 }] },
      "comments[0] has unknown fields position",
    ],
  ])("rejects a review with %s", async (_name, content, expected) => {
    const message = await badInput(reviewWith(content));
    expect(message).toContain(expected);
    expect(message).toContain("Fix the file");
  });
});

describe("post-review GitHub errors", () => {
  it("exits 1 with not_installed", async () => {
    const github = mockGitHub([{ status: 404, body: { message: "Not Found" } }]);

    const result = await run(args(), github.options);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.error?.error).toBe("not_installed");
    expect(result.error?.message).toContain("Install it");
  });

  it("exits 3 with head_moved and the current head, and posts nothing", async () => {
    const newHead = "b".repeat(40);
    const github = mockGitHub([installation, token, { status: 200, body: { head: { sha: newHead } } }]);

    const result = await run(args(), github.options);

    expect(result.code).toBe(3);
    expect(result.error).toMatchObject({ error: "head_moved", current_head: newHead });
    expect(github.calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  it("exits 1 with github_error, the status and what to check", async () => {
    const github = mockGitHub([
      installation,
      token,
      pull,
      { status: 422, body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] } },
    ]);

    const result = await run(args(), github.options);

    expect(result.code).toBe(1);
    expect(result.error).toMatchObject({ error: "github_error", status: 422 });
    expect(result.error?.message).toContain("Line could not be resolved");
    expect(result.error?.message).toContain("in the pull request diff");
  });

  it("exits 1 with github_error and no status when GitHub cannot be reached", async () => {
    const options: ClientOptions = {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
      },
    };

    const result = await run(args(), options);

    expect(result.code).toBe(1);
    expect(result.error?.error).toBe("github_error");
    expect(result.error?.status).toBeUndefined();
    expect(result.error?.message).toContain("ENOTFOUND");
    expect(result.error?.message).toContain("network");
  });
});

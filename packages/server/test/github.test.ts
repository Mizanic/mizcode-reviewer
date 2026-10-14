import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubClientError,
  createAppJwt,
  postReviewAsApp,
  type ClientOptions,
  type Review,
} from "../src/github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const repo = { owner: "acme", name: "widgets" };
const sha = "a".repeat(40);
const review: Review = {
  body: "Summary",
  comments: [
    { path: "src/app.ts", line: 120, side: "RIGHT", start_line: 115, start_side: "RIGHT", body: "Multi-line" },
    { path: "src/util.ts", line: 4, side: "RIGHT", body: "Single line" },
  ],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

// Answers each request with the next queued response and records the request.
function mockGitHub(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const options: ClientOptions = {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
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

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<GitHubClientError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GitHubClientError);
  return error as GitHubClientError;
}

const input = { appId: "5312457", privateKey: privatePem, repo, pullNumber: 7, sha, review };
const installation = { status: 200, body: { id: 99 } };
const token = { status: 201, body: { token: "ghs_installation", expires_at: "2026-10-14T13:00:00Z" } };
const pull = { status: 200, body: { head: { sha } } };

describe("createAppJwt", () => {
  it("signs an RS256 JWT for the App that GitHub accepts", () => {
    const now = Date.UTC(2026, 9, 14, 12, 0, 0);
    const jwt = createAppJwt("5312457", privatePem, now);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const seconds = now / 1000;
    expect(decode(payload)).toEqual({ iat: seconds - 60, exp: seconds + 540, iss: "5312457" });
    const signed = Buffer.from(`${header}.${payload}`);
    expect(verify("sha256", signed, publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("postReviewAsApp", () => {
  it("signs in, gets a one-repo token, checks the head and posts a COMMENT review", async () => {
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      { status: 200, body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" } },
    ]);

    const result = await postReviewAsApp(input, options);

    expect(result).toEqual({
      review_id: 123,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123",
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/99/access_tokens",
      "GET https://api.github.com/repos/acme/widgets/pulls/7",
      "POST https://api.github.com/repos/acme/widgets/pulls/7/reviews",
    ]);

    for (const call of calls) {
      expect(call.headers.Accept).toBe("application/vnd.github+json");
      expect(call.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(call.headers["User-Agent"]).toBe("mizcode-reviewer");
    }

    const [lookup, mint, read, post] = calls as [Call, Call, Call, Call];
    const appJwt = lookup.headers.Authorization?.replace(/^Bearer /, "") ?? "";
    expect(decode(appJwt.split(".")[1] ?? "").iss).toBe("5312457");
    expect(mint.headers.Authorization).toBe(`Bearer ${appJwt}`);
    expect(mint.body).toEqual({ repositories: ["widgets"] });
    expect(read.headers.Authorization).toBe("Bearer ghs_installation");
    expect(post.headers.Authorization).toBe("Bearer ghs_installation");
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.body).toEqual({
      commit_id: sha,
      body: "Summary",
      event: "COMMENT",
      comments: review.comments,
    });
  });

  it("returns not_installed when the App has no installation on the repo", async () => {
    const { calls, options } = mockGitHub([{ status: 404, body: { message: "Not Found" } }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("not_installed");
    expect(error.message).toContain("acme/widgets");
    expect(calls).toHaveLength(1);
  });

  it("returns head_moved with the current head and posts nothing", async () => {
    const newHead = "b".repeat(40);
    const { calls, options } = mockGitHub([installation, token, { status: 200, body: { head: { sha: newHead } } }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("head_moved");
    expect(error.currentHead).toBe(newHead);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  it("turns a 422 from GitHub into github_error with GitHub's message and status", async () => {
    const { options } = mockGitHub([
      installation,
      token,
      pull,
      {
        status: 422,
        body: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] },
      },
    ]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(422);
    expect(error.message).toContain("Unprocessable Entity");
    expect(error.message).toContain("Line could not be resolved");
  });

  it("keeps a non-JSON error body as the message", async () => {
    const { options } = mockGitHub([{ status: 502, body: "Bad gateway" }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(502);
    expect(error.message).toContain("Bad gateway");
  });

  it("does not report a token failure as not_installed", async () => {
    const { options } = mockGitHub([installation, { status: 403, body: { message: "Resource not accessible by integration" } }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(403);
    expect(error.message).toContain("Resource not accessible by integration");
  });
});

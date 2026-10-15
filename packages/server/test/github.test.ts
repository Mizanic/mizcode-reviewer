import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubClientError,
  ReviewThreadsError,
  createAppJwt,
  createRepoToken,
  getPullRequest,
  getPullRequestDiff,
  getReviewThreads,
  listPullRequestFiles,
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
const app = { status: 200, body: { id: 5312457, slug: "mizcode-reviewer" } };
const noReviews = { status: 200, body: [] };
const bot = { login: "mizcode-reviewer[bot]" };
const existingUrl = "https://github.com/acme/widgets/pull/7#pullrequestreview-50";

// A review as GET /pulls/{n}/reviews lists it.
function listed(overrides: Record<string, unknown> = {}) {
  return { id: 50, html_url: existingUrl, user: bot, commit_id: sha, body: "Summary", ...overrides };
}

// Inline comments as GET /pulls/{n}/comments lists them, all from one review.
// line follows the current head; original_line stays where it was posted.
function postedComments(comments = review.comments, reviewId = 50) {
  return comments.map((c) => ({
    pull_request_review_id: reviewId,
    path: c.path,
    line: null,
    original_line: c.line,
    side: c.side,
    start_line: null,
    original_start_line: c.start_line ?? null,
    start_side: c.start_side ?? null,
    body: c.body,
  }));
}

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
      app,
      noReviews,
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
      "GET https://api.github.com/app",
      "GET https://api.github.com/repos/acme/widgets/pulls/7/reviews?per_page=100&page=1",
      "POST https://api.github.com/repos/acme/widgets/pulls/7/reviews",
    ]);

    for (const call of calls) {
      expect(call.headers.Accept).toBe("application/vnd.github+json");
      expect(call.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(call.headers["User-Agent"]).toBe("mizcode-reviewer");
    }

    const [lookup, mint, read, whoami, list, post] = calls as [Call, Call, Call, Call, Call, Call];
    const appJwt = lookup.headers.Authorization?.replace(/^Bearer /, "") ?? "";
    expect(decode(appJwt.split(".")[1] ?? "").iss).toBe("5312457");
    expect(mint.headers.Authorization).toBe(`Bearer ${appJwt}`);
    expect(mint.body).toEqual({ repositories: ["widgets"] });
    expect(read.headers.Authorization).toBe("Bearer ghs_installation");
    expect(whoami.headers.Authorization).toBe(`Bearer ${appJwt}`);
    expect(list.headers.Authorization).toBe("Bearer ghs_installation");
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
      app,
      noReviews,
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

  it("returns the App's identical review at this commit and posts nothing", async () => {
    const reordered = postedComments([...review.comments].reverse());
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      { status: 200, body: [listed()] },
      { status: 200, body: reordered },
    ]);

    const result = await postReviewAsApp(input, options);

    expect(result).toEqual({ review_id: 50, html_url: existingUrl });
    expect(calls.at(-1)?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/comments?per_page=100&page=1");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  it("compares only the comments of each candidate review", async () => {
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      { status: 200, body: [listed({ id: 40 }), listed()] },
      {
        status: 200,
        body: [
          ...postedComments([review.comments[0]!], 40),
          ...postedComments(review.comments, 60),
          { ...postedComments([review.comments[0]!], 70)[0]!, body: "A reply", original_line: 120 },
          ...postedComments(),
        ],
      },
    ]);

    const result = await postReviewAsApp(input, options);

    expect(result).toEqual({ review_id: 50, html_url: existingUrl });
    expect(calls.filter((c) => c.url.includes("/comments"))).toHaveLength(1);
  });

  it("posts when the reviews with this body are by someone else or at another commit", async () => {
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      {
        status: 200,
        body: [
          listed({ id: 1, user: { login: "rehanhaider" } }),
          listed({ id: 2, user: null }),
          listed({ id: 3, user: { login: "other-app[bot]" } }),
          listed({ id: 4, commit_id: "b".repeat(40) }),
          listed({ id: 5, body: "Another summary" }),
        ],
      },
      { status: 200, body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" } },
    ]);

    const result = await postReviewAsApp(input, options);

    expect(result.review_id).toBe(123);
    expect(calls.some((c) => c.url.includes("/comments"))).toBe(false);
    expect(calls.at(-1)?.method).toBe("POST");
  });

  it.each([
    ["a comment's body", (c: ReturnType<typeof postedComments>) => [{ ...c[0]!, body: "Other" }, c[1]!]],
    ["a comment's line", (c: ReturnType<typeof postedComments>) => [c[0]!, { ...c[1]!, original_line: 5 }]],
    ["a comment's start line", (c: ReturnType<typeof postedComments>) => [{ ...c[0]!, original_start_line: 114 }, c[1]!]],
    ["a comment's side", (c: ReturnType<typeof postedComments>) => [c[0]!, { ...c[1]!, side: "LEFT" }]],
    ["a comment's path", (c: ReturnType<typeof postedComments>) => [c[0]!, { ...c[1]!, path: "src/other.ts" }]],
    ["one comment fewer", (c: ReturnType<typeof postedComments>) => [c[0]!]],
    ["one comment more", (c: ReturnType<typeof postedComments>) => [...c, c[1]!]],
  ])("posts when the App's review at this commit has the same body but differs in %s", async (_name, change) => {
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      { status: 200, body: [listed()] },
      { status: 200, body: change(postedComments()) },
      { status: 200, body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" } },
    ]);

    const result = await postReviewAsApp(input, options);

    expect(result.review_id).toBe(123);
    expect(calls.at(-1)?.method).toBe("POST");
  });

  it("ignores the start side GitHub fills in when the review leaves it out", async () => {
    const comment = { path: "src/app.ts", line: 120, side: "RIGHT" as const, start_line: 115, body: "Multi-line" };
    const { options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      { status: 200, body: [listed()] },
      { status: 200, body: postedComments([{ ...comment, start_side: "RIGHT" }]) },
    ]);

    const result = await postReviewAsApp({ ...input, review: { body: "Summary", comments: [comment] } }, options);

    expect(result).toEqual({ review_id: 50, html_url: existingUrl });
  });

  it("reads every page of reviews and of the PR's comments", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts`, line: 1, side: "RIGHT" as const, body: "B" }));
    const others = Array.from({ length: 100 }, (_, i) => listed({ id: 1000 + i, user: { login: "someone" } }));
    const comments = postedComments([...many, review.comments[0]!]);
    const { calls, options } = mockGitHub([
      installation,
      token,
      pull,
      app,
      { status: 200, body: others },
      { status: 200, body: [listed()] },
      { status: 200, body: comments.slice(0, 100) },
      { status: 200, body: comments.slice(100) },
    ]);

    const result = await postReviewAsApp(
      { ...input, review: { body: "Summary", comments: [review.comments[0]!, ...many] } },
      options,
    );

    expect(result).toEqual({ review_id: 50, html_url: existingUrl });
    expect(calls.slice(4).map((c) => c.url.replace("https://api.github.com/repos/acme/widgets/pulls/7", ""))).toEqual([
      "/reviews?per_page=100&page=1",
      "/reviews?per_page=100&page=2",
      "/comments?per_page=100&page=1",
      "/comments?per_page=100&page=2",
    ]);
  });

  it("posts nothing when the reviews cannot be listed", async () => {
    const { calls, options } = mockGitHub([installation, token, pull, app, { status: 500, body: { message: "Server Error" } }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(500);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/reviews"))).toBe(false);
  });

  it("does not report a token failure as not_installed", async () => {
    const { options } = mockGitHub([installation, { status: 403, body: { message: "Resource not accessible by integration" } }]);

    const error = await rejection(postReviewAsApp(input, options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(403);
    expect(error.message).toContain("Resource not accessible by integration");
  });
});

describe("PR reads", () => {
  it("signs in and gets a token for the one repo", async () => {
    const { calls, options } = mockGitHub([installation, token]);

    expect(await createRepoToken("5312457", privatePem, repo, options)).toBe("ghs_installation");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/widgets/installation",
      "POST https://api.github.com/app/installations/99/access_tokens",
    ]);
    expect(calls[1]?.body).toEqual({ repositories: ["widgets"] });
  });

  it("reads the PR and turns a null body into an empty string", async () => {
    const { calls, options } = mockGitHub([
      {
        status: 200,
        body: {
          number: 7,
          title: "Add widgets",
          body: null,
          html_url: "https://github.com/acme/widgets/pull/7",
          base: { ref: "main" },
          head: { sha },
          changed_files: 2,
          additions: 12,
          deletions: 3,
        },
      },
    ]);

    expect(await getPullRequest(repo, 7, "ghs_installation", options)).toEqual({
      number: 7,
      title: "Add widgets",
      body: "",
      url: "https://github.com/acme/widgets/pull/7",
      base: "main",
      headSha: sha,
      changedFiles: 2,
      additions: 12,
      deletions: 3,
    });
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghs_installation");
  });

  it("stops listing files after a short page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: i, deletions: 0 }));
    const { calls, options } = mockGitHub([{ status: 200, body: full }, { status: 200, body: [] }]);

    const files = await listPullRequestFiles(repo, 7, "ghs_installation", options);

    expect(files).toHaveLength(100);
    expect(files[1]).toEqual({ path: "f1.ts", additions: 1, deletions: 0 });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=2",
    ]);
  });

  it("asks for the diff media type and returns the diff text", async () => {
    const { calls, options } = mockGitHub([{ status: 200, body: "diff --git a/x b/x\n" }]);

    expect(await getPullRequestDiff(repo, 7, "ghs_installation", options)).toBe("diff --git a/x b/x\n");
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.diff");
  });

  it("turns a refused diff into github_error", async () => {
    const { options } = mockGitHub([{ status: 406, body: { message: "Sorry, the diff exceeded the maximum number of lines" } }]);

    const error = await rejection(getPullRequestDiff(repo, 7, "ghs_installation", options));

    expect(error.code).toBe("github_error");
    expect(error.status).toBe(406);
  });

  it("reads review threads over GraphQL", async () => {
    const node = {
      isResolved: true,
      isOutdated: true,
      path: "src/app.ts",
      line: null,
      comments: { totalCount: 3, nodes: [{ author: { login: "octocat" }, body: "Rename this" }] },
    };
    const { calls, options } = mockGitHub([
      {
        status: 200,
        body: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } } } },
      },
    ]);

    expect(await getReviewThreads(repo, 7, "ghs_installation", options)).toEqual([
      {
        path: "src/app.ts",
        line: null,
        isResolved: true,
        isOutdated: true,
        author: "octocat",
        body: "Rename this",
        commentCount: 3,
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.method).toBe("POST");
  });

  it("reports a missing pull request in GraphQL as github_error", async () => {
    const { options } = mockGitHub([{ status: 200, body: { data: { repository: { pullRequest: null } } } }]);

    const error = await rejection(getReviewThreads(repo, 7, "ghs_installation", options));

    expect(error).toBeInstanceOf(ReviewThreadsError);
    expect(error.code).toBe("github_error");
    expect((error as ReviewThreadsError).threads).toEqual([]);
  });

  it("keeps the HTTP status when the GraphQL request is refused", async () => {
    const { options } = mockGitHub([{ status: 401, body: { message: "Bad credentials" } }]);

    const error = await rejection(getReviewThreads(repo, 7, "ghs_installation", options));

    expect(error.status).toBe(401);
    expect(error.message).toContain("Bad credentials");
  });
});

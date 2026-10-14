// GitHub client for post-review: App JWT, installation lookup, a token for one
// repo, the PR head check, and a COMMENT review. Every failure is a
// GitHubClientError whose code matches the post-review error contract.

import { sign } from "node:crypto";

const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "mizcode-reviewer";

export type ErrorCode = "not_installed" | "github_error" | "head_moved";

export class GitHubClientError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly currentHead?: string;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { status?: number; currentHead?: string } = {},
  ) {
    super(message);
    this.name = "GitHubClientError";
    this.code = code;
    this.status = extra.status;
    this.currentHead = extra.currentHead;
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface Repo {
  owner: string;
  name: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export interface Review {
  body: string;
  comments: ReviewComment[];
}

export interface PostedReview {
  review_id: number;
  html_url: string;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

// RS256 JWT for the App. iat is backdated 60s for clock drift and exp stays
// under GitHub's 10-minute limit.
export function createAppJwt(
  appId: string,
  privateKey: string,
  now: number = Date.now(),
): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function request(
  options: ClientOptions,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${bearer}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return doFetch(`${options.baseUrl ?? API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function githubError(response: Response): Promise<GitHubClientError> {
  const text = await response.text();
  let message = text || response.statusText;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; errors?: unknown };
    if (typeof parsed.message === "string") {
      message = parsed.message;
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        message += `: ${JSON.stringify(parsed.errors)}`;
      }
    }
  } catch {
    // Not JSON. Keep the raw text.
  }
  return new GitHubClientError(
    "github_error",
    `GitHub returned ${response.status}: ${message}`,
    { status: response.status },
  );
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await githubError(response);
  return (await response.json()) as T;
}

function repoPath(repo: Repo): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

export async function getInstallationId(
  repo: Repo,
  appJwt: string,
  options: ClientOptions = {},
): Promise<number> {
  const response = await request(options, "GET", `${repoPath(repo)}/installation`, appJwt);
  if (response.status === 404) {
    throw new GitHubClientError(
      "not_installed",
      `The App is not installed on ${repo.owner}/${repo.name}. Install it on that repository and try again.`,
    );
  }
  const installation = await json<{ id: number }>(response);
  return installation.id;
}

// Installation tokens last one hour. The repositories list limits this one
// to the single repo being reviewed.
export async function createInstallationToken(
  installationId: number,
  repo: Repo,
  appJwt: string,
  options: ClientOptions = {},
): Promise<string> {
  const response = await request(
    options,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    { repositories: [repo.name] },
  );
  const token = await json<{ token: string }>(response);
  return token.token;
}

export async function getPullRequestHead(
  repo: Repo,
  pullNumber: number,
  token: string,
  options: ClientOptions = {},
): Promise<string> {
  const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}`, token);
  const pull = await json<{ head: { sha: string } }>(response);
  return pull.head.sha;
}

export async function assertHead(
  repo: Repo,
  pullNumber: number,
  expectedSha: string,
  token: string,
  options: ClientOptions = {},
): Promise<void> {
  const currentHead = await getPullRequestHead(repo, pullNumber, token, options);
  if (currentHead !== expectedSha) {
    throw new GitHubClientError(
      "head_moved",
      `The pull request head is now ${currentHead}, not ${expectedSha}. Review the new head and post again.`,
      { currentHead },
    );
  }
}

// The event is always COMMENT. This client never approves or requests changes.
export async function postReview(
  repo: Repo,
  pullNumber: number,
  commitId: string,
  review: Review,
  token: string,
  options: ClientOptions = {},
): Promise<PostedReview> {
  const response = await request(options, "POST", `${repoPath(repo)}/pulls/${pullNumber}/reviews`, token, {
    commit_id: commitId,
    body: review.body,
    event: "COMMENT",
    comments: review.comments,
  });
  const posted = await json<{ id: number; html_url: string }>(response);
  return { review_id: posted.id, html_url: posted.html_url };
}

export interface PostReviewAsAppInput {
  appId: string;
  privateKey: string;
  repo: Repo;
  pullNumber: number;
  sha: string;
  review: Review;
}

// The whole flow: sign in as the App, get a token for the repo, refuse a moved
// head, then post.
export async function postReviewAsApp(
  input: PostReviewAsAppInput,
  options: ClientOptions = {},
): Promise<PostedReview> {
  const appJwt = createAppJwt(input.appId, input.privateKey);
  const installationId = await getInstallationId(input.repo, appJwt, options);
  const token = await createInstallationToken(installationId, input.repo, appJwt, options);
  await assertHead(input.repo, input.pullNumber, input.sha, token, options);
  return postReview(input.repo, input.pullNumber, input.sha, input.review, token, options);
}

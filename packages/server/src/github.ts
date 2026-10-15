// GitHub client for post-review and review.js: App JWT, installation
// lookup, a token for one repo, reads of the PR, its files, diff and review
// threads, the PR head check, the duplicate check, and a COMMENT review.
// Every failure is a GitHubClientError whose code matches the post-review
// error contract.

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
  accept = "application/vnd.github+json",
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: accept,
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

// Signs in as the App and returns an installation token for the one repo.
export async function createRepoToken(
  appId: string,
  privateKey: string,
  repo: Repo,
  options: ClientOptions = {},
): Promise<string> {
  const appJwt = createAppJwt(appId, privateKey);
  const installationId = await getInstallationId(repo, appJwt, options);
  return createInstallationToken(installationId, repo, appJwt, options);
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

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  base: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export async function getPullRequest(
  repo: Repo,
  pullNumber: number,
  token: string,
  options: ClientOptions = {},
): Promise<PullRequest> {
  const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}`, token);
  const pull = await json<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    base: { ref: string };
    head: { sha: string };
    changed_files: number;
    additions: number;
    deletions: number;
  }>(response);
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    url: pull.html_url,
    base: pull.base.ref,
    headSha: pull.head.sha,
    changedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
  };
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

// GitHub lists at most 3000 files, 100 a page. A short page is the last one.
export async function listPullRequestFiles(
  repo: Repo,
  pullNumber: number,
  token: string,
  options: ClientOptions = {},
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (let page = 1; ; page++) {
    const response = await request(
      options,
      "GET",
      `${repoPath(repo)}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      token,
    );
    const rows = await json<Array<{ filename: string; additions: number; deletions: number }>>(response);
    for (const row of rows) files.push({ path: row.filename, additions: row.additions, deletions: row.deletions });
    if (rows.length < 100) return files;
  }
}

// The whole PR diff against its base, as one unified diff.
export async function getPullRequestDiff(
  repo: Repo,
  pullNumber: number,
  token: string,
  options: ClientOptions = {},
): Promise<string> {
  const response = await request(
    options,
    "GET",
    `${repoPath(repo)}/pulls/${pullNumber}`,
    token,
    undefined,
    "application/vnd.github.diff",
  );
  if (!response.ok) throw await githubError(response);
  return response.text();
}

export interface ReviewThread {
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  author: string | null;
  body: string;
  commentCount: number;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            totalCount
            nodes { author { login } body }
          }
        }
      }
    }
  }
}`;

interface ThreadsPage {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            isResolved: boolean;
            isOutdated: boolean;
            path: string;
            line: number | null;
            comments: { totalCount: number; nodes: Array<{ author: { login: string } | null; body: string }> };
          }>;
        };
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

// Review threads and whether each is resolved. Only GraphQL has this. When a
// later page fails, the error carries the threads read so far.
export class ReviewThreadsError extends GitHubClientError {
  readonly threads: ReviewThread[];

  constructor(error: GitHubClientError, threads: ReviewThread[]) {
    super(error.code, error.message, { status: error.status });
    this.name = "ReviewThreadsError";
    this.threads = threads;
  }
}

export async function getReviewThreads(
  repo: Repo,
  pullNumber: number,
  token: string,
  options: ClientOptions = {},
): Promise<ReviewThread[]> {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  for (;;) {
    let page: ThreadsPage;
    try {
      const response = await request(options, "POST", "/graphql", token, {
        query: THREADS_QUERY,
        variables: { owner: repo.owner, name: repo.name, number: pullNumber, cursor },
      });
      page = await json<ThreadsPage>(response);
    } catch (error) {
      if (error instanceof GitHubClientError) throw new ReviewThreadsError(error, threads);
      // fetch throws without an HTTP status when GitHub cannot be reached.
      const cause = (error as Error & { cause?: Error }).cause;
      const message = `Could not reach GitHub: ${cause?.message ?? (error as Error).message}`;
      throw new ReviewThreadsError(new GitHubClientError("github_error", message), threads);
    }
    const connection = page.data?.repository?.pullRequest?.reviewThreads;
    if (page.errors?.length || !connection) {
      const message = page.errors?.map((e) => e.message).join("; ") || "no reviewThreads in the response";
      throw new ReviewThreadsError(
        new GitHubClientError("github_error", `GitHub GraphQL returned an error: ${message}`),
        threads,
      );
    }
    for (const node of connection.nodes) {
      const first = node.comments.nodes[0];
      threads.push({
        path: node.path,
        line: node.line,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        author: first?.author?.login ?? null,
        body: first?.body ?? "",
        commentCount: node.comments.totalCount,
      });
    }
    if (!connection.pageInfo.hasNextPage) return threads;
    cursor = connection.pageInfo.endCursor;
  }
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

// The login GitHub shows for the App's reviews: its slug plus "[bot]".
export async function getAppLogin(appJwt: string, options: ClientOptions = {}): Promise<string> {
  const response = await request(options, "GET", "/app", appJwt);
  const app = await json<{ slug: string }>(response);
  return `${app.slug}[bot]`;
}

interface PostedComment {
  path: string;
  original_line: number | null;
  original_start_line: number | null;
  side: string | null;
  start_side: string | null;
  body: string;
}

// GitHub moves line to the current head but keeps original_line at the commit
// the review was posted on. start_side is compared only when the review sets
// it, because GitHub fills in its own value otherwise.
function sameComment(wanted: ReviewComment, posted: PostedComment): boolean {
  return (
    posted.path === wanted.path &&
    posted.original_line === wanted.line &&
    posted.side === wanted.side &&
    posted.original_start_line === (wanted.start_line ?? null) &&
    (wanted.start_side === undefined || posted.start_side === wanted.start_side) &&
    posted.body === wanted.body
  );
}

function sameComments(wanted: ReviewComment[], posted: PostedComment[]): boolean {
  if (wanted.length !== posted.length) return false;
  const unmatched = [...posted];
  for (const comment of wanted) {
    const i = unmatched.findIndex((p) => sameComment(comment, p));
    if (i === -1) return false;
    unmatched.splice(i, 1);
  }
  return true;
}

async function listReviewComments(
  repo: Repo,
  pullNumber: number,
  reviewId: number,
  token: string,
  options: ClientOptions,
): Promise<PostedComment[]> {
  const comments: PostedComment[] = [];
  for (let page = 1; ; page++) {
    const response = await request(
      options,
      "GET",
      `${repoPath(repo)}/pulls/${pullNumber}/reviews/${reviewId}/comments?per_page=100&page=${page}`,
      token,
    );
    const rows = await json<PostedComment[]>(response);
    comments.push(...rows);
    if (rows.length < 100) return comments;
  }
}

// The review by login at commitId with the same body and the same inline
// comments, in any order, or null. Two reviews can share a body but carry
// different findings, so the comments are compared too.
export async function findPostedReview(
  repo: Repo,
  pullNumber: number,
  commitId: string,
  review: Review,
  login: string,
  token: string,
  options: ClientOptions = {},
): Promise<PostedReview | null> {
  for (let page = 1; ; page++) {
    const response = await request(
      options,
      "GET",
      `${repoPath(repo)}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`,
      token,
    );
    const rows = await json<
      Array<{ id: number; html_url: string; user: { login: string } | null; commit_id: string; body: string | null }>
    >(response);
    for (const row of rows) {
      if (row.user?.login !== login || row.commit_id !== commitId || row.body !== review.body) continue;
      const comments = await listReviewComments(repo, pullNumber, row.id, token, options);
      if (sameComments(review.comments, comments)) return { review_id: row.id, html_url: row.html_url };
    }
    if (rows.length < 100) return null;
  }
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
// head, return the App's identical review at this commit if it already posted
// one, then post. A caller that lost the reply to an earlier post can run this
// again without posting every comment twice.
export async function postReviewAsApp(
  input: PostReviewAsAppInput,
  options: ClientOptions = {},
): Promise<PostedReview> {
  const appJwt = createAppJwt(input.appId, input.privateKey);
  const installationId = await getInstallationId(input.repo, appJwt, options);
  const token = await createInstallationToken(installationId, input.repo, appJwt, options);
  await assertHead(input.repo, input.pullNumber, input.sha, token, options);
  const login = await getAppLogin(appJwt, options);
  const existing = await findPostedReview(input.repo, input.pullNumber, input.sha, input.review, login, token, options);
  if (existing) return existing;
  return postReview(input.repo, input.pullNumber, input.sha, input.review, token, options);
}

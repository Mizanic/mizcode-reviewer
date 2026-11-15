// GitHub client for post-review and review.js: App JWT, installation
// lookup, a token for one repo, reads of the PR, its files, diff and review
// threads, the PR head check, the duplicate check, and a COMMENT review.
// Every failure is a GitHubClientError whose code matches the post-review
// error contract.
import { sign } from "node:crypto";
const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "mizcode-reviewer";
export class GitHubClientError extends Error {
    code;
    status;
    currentHead;
    constructor(code, message, extra = {}) {
        super(message);
        this.name = "GitHubClientError";
        this.code = code;
        this.status = extra.status;
        this.currentHead = extra.currentHead;
    }
}
function base64url(input) {
    return Buffer.from(input).toString("base64url");
}
// RS256 JWT for the App. iat is backdated 60s for clock drift and exp stays
// under GitHub's 10-minute limit.
export function createAppJwt(appId, privateKey, now = Date.now()) {
    const seconds = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${base64url(signature)}`;
}
async function request(options, method, path, bearer, body, accept = "application/vnd.github+json") {
    const doFetch = options.fetch ?? fetch;
    const headers = {
        Accept: accept,
        Authorization: `Bearer ${bearer}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
    };
    if (body !== undefined)
        headers["Content-Type"] = "application/json";
    return doFetch(`${options.baseUrl ?? API_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
async function githubError(response) {
    const text = await response.text();
    let message = text || response.statusText;
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed.message === "string") {
            message = parsed.message;
            if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
                message += `: ${JSON.stringify(parsed.errors)}`;
            }
        }
    }
    catch {
        // Not JSON. Keep the raw text.
    }
    return new GitHubClientError("github_error", `GitHub returned ${response.status}: ${message}`, { status: response.status });
}
async function json(response) {
    if (!response.ok)
        throw await githubError(response);
    return (await response.json());
}
function repoPath(repo) {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
export async function getInstallationId(repo, appJwt, options = {}) {
    const response = await request(options, "GET", `${repoPath(repo)}/installation`, appJwt);
    if (response.status === 404) {
        throw new GitHubClientError("not_installed", `The App is not installed on ${repo.owner}/${repo.name}. Install it on that repository and try again.`);
    }
    const installation = await json(response);
    return installation.id;
}
// Installation tokens last one hour. The repositories list limits this one
// to the single repo being reviewed.
export async function createInstallationToken(installationId, repo, appJwt, options = {}) {
    const response = await request(options, "POST", `/app/installations/${installationId}/access_tokens`, appJwt, { repositories: [repo.name] });
    const token = await json(response);
    return token.token;
}
// Signs in as the App and returns an installation token for the one repo.
export async function createRepoToken(appId, privateKey, repo, options = {}) {
    const appJwt = createAppJwt(appId, privateKey);
    const installationId = await getInstallationId(repo, appJwt, options);
    return createInstallationToken(installationId, repo, appJwt, options);
}
export async function getPullRequestHead(repo, pullNumber, token, options = {}) {
    const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}`, token);
    const pull = await json(response);
    return pull.head.sha;
}
export async function getPullRequest(repo, pullNumber, token, options = {}) {
    const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}`, token);
    const pull = await json(response);
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
// GitHub lists at most 3000 files, 100 a page. A short page is the last one.
export async function listPullRequestFiles(repo, pullNumber, token, options = {}) {
    const files = [];
    for (let page = 1;; page++) {
        const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}/files?per_page=100&page=${page}`, token);
        const rows = await json(response);
        for (const row of rows)
            files.push({ path: row.filename, additions: row.additions, deletions: row.deletions });
        if (rows.length < 100)
            return files;
    }
}
// The whole PR diff against its base, as one unified diff.
export async function getPullRequestDiff(repo, pullNumber, token, options = {}) {
    const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}`, token, undefined, "application/vnd.github.diff");
    if (!response.ok)
        throw await githubError(response);
    return response.text();
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
// Review threads and whether each is resolved. Only GraphQL has this. When a
// later page fails, the error carries the threads read so far.
export class ReviewThreadsError extends GitHubClientError {
    threads;
    constructor(error, threads) {
        super(error.code, error.message, { status: error.status });
        this.name = "ReviewThreadsError";
        this.threads = threads;
    }
}
export async function getReviewThreads(repo, pullNumber, token, options = {}) {
    const threads = [];
    let cursor = null;
    for (;;) {
        let page;
        try {
            const response = await request(options, "POST", "/graphql", token, {
                query: THREADS_QUERY,
                variables: { owner: repo.owner, name: repo.name, number: pullNumber, cursor },
            });
            page = await json(response);
        }
        catch (error) {
            if (error instanceof GitHubClientError)
                throw new ReviewThreadsError(error, threads);
            // fetch throws without an HTTP status when GitHub cannot be reached.
            const cause = error.cause;
            const message = `Could not reach GitHub: ${cause?.message ?? error.message}`;
            throw new ReviewThreadsError(new GitHubClientError("github_error", message), threads);
        }
        const connection = page.data?.repository?.pullRequest?.reviewThreads;
        if (page.errors?.length || !connection) {
            const message = page.errors?.map((e) => e.message).join("; ") || "no reviewThreads in the response";
            throw new ReviewThreadsError(new GitHubClientError("github_error", `GitHub GraphQL returned an error: ${message}`), threads);
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
        if (!connection.pageInfo.hasNextPage)
            return threads;
        cursor = connection.pageInfo.endCursor;
    }
}
export async function assertHead(repo, pullNumber, expectedSha, token, options = {}) {
    const currentHead = await getPullRequestHead(repo, pullNumber, token, options);
    if (currentHead !== expectedSha) {
        throw new GitHubClientError("head_moved", `The pull request head is now ${currentHead}, not ${expectedSha}. Review the new head and post again.`, { currentHead });
    }
}
// GitHub reports maintain as write and triage as read, so write and admin
// are the two values that allow a post.
export async function assertCanWrite(repo, login, token, options = {}) {
    const response = await request(options, "GET", `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`, token);
    let permission = "none";
    if (response.status !== 404)
        permission = (await json(response)).permission;
    if (permission !== "write" && permission !== "admin") {
        throw new GitHubClientError("no_access", `${login} has ${permission} permission on ${repo.owner}/${repo.name}. Posting a review needs write permission.`);
    }
}
// Asks GitHub whether token is a user access token that the App with this
// client ID issued, and returns the user's login, or null for any other
// token. The check uses the App's client ID and secret, not the token itself.
export async function checkUserToken(clientId, clientSecret, token, options = {}) {
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(`${options.baseUrl ?? API_URL}/applications/${encodeURIComponent(clientId)}/token`, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": API_VERSION,
        },
        body: JSON.stringify({ access_token: token }),
    });
    if (response.status === 404)
        return null;
    const checked = await json(response);
    if (checked.app?.client_id !== clientId || typeof checked.user?.login !== "string")
        return null;
    return checked.user.login;
}
// The event is always COMMENT. This client never approves or requests changes.
export async function postReview(repo, pullNumber, commitId, review, token, options = {}) {
    const response = await request(options, "POST", `${repoPath(repo)}/pulls/${pullNumber}/reviews`, token, {
        commit_id: commitId,
        body: review.body,
        event: "COMMENT",
        comments: review.comments,
    });
    const posted = await json(response);
    return { review_id: posted.id, html_url: posted.html_url };
}
// The login GitHub shows for the App's reviews: its slug plus "[bot]".
export async function getAppLogin(appJwt, options = {}) {
    const response = await request(options, "GET", "/app", appJwt);
    const app = await json(response);
    return `${app.slug}[bot]`;
}
// GitHub moves line to the current head but keeps original_line at the commit
// the review was posted on. start_side is compared only when the review sets
// it, because GitHub fills in its own value otherwise.
function sameComment(wanted, posted) {
    return (posted.path === wanted.path &&
        posted.original_line === wanted.line &&
        posted.side === wanted.side &&
        posted.original_start_line === (wanted.start_line ?? null) &&
        (wanted.start_side === undefined || posted.start_side === wanted.start_side) &&
        posted.body === wanted.body);
}
function sameComments(wanted, posted) {
    if (wanted.length !== posted.length)
        return false;
    const unmatched = [...posted];
    for (const comment of wanted) {
        const i = unmatched.findIndex((p) => sameComment(comment, p));
        if (i === -1)
            return false;
        unmatched.splice(i, 1);
    }
    return true;
}
// Every inline comment on the PR. The per-review comments endpoint leaves out
// line and side, so this list is read instead and grouped by review.
async function listPullRequestComments(repo, pullNumber, token, options) {
    const comments = [];
    for (let page = 1;; page++) {
        const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}/comments?per_page=100&page=${page}`, token);
        const rows = await json(response);
        comments.push(...rows);
        if (rows.length < 100)
            return comments;
    }
}
// The review by login at commitId with the same body and the same inline
// comments, in any order, or null. Two reviews can share a body but carry
// different findings, so the comments are compared too.
export async function findPostedReview(repo, pullNumber, commitId, review, login, token, options = {}) {
    const candidates = [];
    for (let page = 1;; page++) {
        const response = await request(options, "GET", `${repoPath(repo)}/pulls/${pullNumber}/reviews?per_page=100&page=${page}`, token);
        const rows = await json(response);
        for (const row of rows) {
            if (row.user?.login === login && row.commit_id === commitId && row.body === review.body) {
                candidates.push({ review_id: row.id, html_url: row.html_url });
            }
        }
        if (rows.length < 100)
            break;
    }
    if (candidates.length === 0)
        return null;
    const comments = await listPullRequestComments(repo, pullNumber, token, options);
    for (const candidate of candidates) {
        const own = comments.filter((c) => c.pull_request_review_id === candidate.review_id);
        if (sameComments(review.comments, own))
            return candidate;
    }
    return null;
}
// The whole flow: sign in as the App, get a token for the repo, refuse a moved
// head, return the App's identical review at this commit if it already posted
// one, then post. A caller that lost the reply to an earlier post can run this
// again without posting every comment twice.
export async function postReviewAsApp(input, options = {}) {
    const appJwt = createAppJwt(input.appId, input.privateKey);
    const installationId = await getInstallationId(input.repo, appJwt, options);
    const token = await createInstallationToken(installationId, input.repo, appJwt, options);
    if (input.forUser !== undefined)
        await assertCanWrite(input.repo, input.forUser, token, options);
    await assertHead(input.repo, input.pullNumber, input.sha, token, options);
    const login = await getAppLogin(appJwt, options);
    const existing = await findPostedReview(input.repo, input.pullNumber, input.sha, input.review, login, token, options);
    if (existing)
        return existing;
    return postReview(input.repo, input.pullNumber, input.sha, input.review, token, options);
}

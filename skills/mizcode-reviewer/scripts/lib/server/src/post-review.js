// The post-review command: read the flags, the key file and review.json, post
// the review as the App, and print the result or a JSON error. runPostReview
// returns the exit code instead of exiting, so tests can call it.
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { GitHubClientError, postReviewAsApp, } from "./github.js";
export const USAGE = `Usage: post-review --app-id <id> --key-file <path> --repo <owner/name> --pr <number> --sha <commit> --review <review.json>

Posts the review to the pull request as a COMMENT review from the GitHub App.
Posts nothing if the pull request head is no longer <commit>. If the App
already posted the same review at <commit>, posts nothing and prints that
review's ID and URL.

Options:
  --app-id <id>        The GitHub App ID
  --key-file <path>    The App's private key, the .pem file from the App settings
  --repo <owner/name>  The repository
  --pr <number>        The pull request number
  --sha <commit>       The full commit SHA the review was written against
  --review <path>      The review: {"body": "...", "comments": [...]}
  -h, --help           Show this help

On success, prints {"review_id": ..., "html_url": "..."} to stdout.
On failure, prints {"error": "...", "message": "..."} to stderr.

Exit codes:
  0  posted
  1  not_installed or github_error
  2  bad_input
  3  head_moved
`;
const OPTIONS = {
    "app-id": { type: "string" },
    "key-file": { type: "string" },
    repo: { type: "string" },
    pr: { type: "string" },
    sha: { type: "string" },
    review: { type: "string" },
    help: { type: "boolean", short: "h" },
};
const REQUIRED = ["app-id", "key-file", "repo", "pr", "sha", "review"];
const SIDES = ["LEFT", "RIGHT"];
class BadInput extends Error {
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
function withoutPeriod(text) {
    return text.replace(/\.+$/, "");
}
async function readInput(path, flag) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new BadInput(`${flag} ${path} does not exist. Check the path and run again.`);
        }
        throw new BadInput(`Could not read ${flag} ${path}: ${withoutPeriod(error.message)}. Check the file and run again.`);
    }
}
// GitHub App keys are RSA. Checking here turns a wrong file into bad_input
// instead of a 401 from GitHub.
function checkPrivateKey(pem, path) {
    let type;
    try {
        type = createPrivateKey(pem).asymmetricKeyType;
    }
    catch {
        type = undefined;
    }
    if (type !== "rsa") {
        throw new BadInput(`--key-file ${path} is not an RSA private key in PEM format. Use the .pem file downloaded from the App's settings page.`);
    }
}
function checkKeys(value, allowed, where) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`${where} has unknown fields ${unknown.join(", ")}; allowed fields are ${allowed.join(", ")}`);
    }
}
function parseComment(value, where) {
    if (!isObject(value))
        throw new Error(`${where} must be an object`);
    checkKeys(value, ["path", "line", "side", "start_line", "start_side", "body"], where);
    if (!isNonEmptyString(value.path))
        throw new Error(`${where}.path must be a non-empty string`);
    if (!isPositiveInteger(value.line))
        throw new Error(`${where}.line must be a positive integer`);
    if (typeof value.side !== "string" || !SIDES.includes(value.side)) {
        throw new Error(`${where}.side must be "LEFT" or "RIGHT"`);
    }
    if (!isNonEmptyString(value.body))
        throw new Error(`${where}.body must be a non-empty string`);
    const comment = {
        path: value.path,
        line: value.line,
        side: value.side,
        body: value.body,
    };
    if (value.start_line !== undefined) {
        if (!isPositiveInteger(value.start_line))
            throw new Error(`${where}.start_line must be a positive integer`);
        comment.start_line = value.start_line;
    }
    if (value.start_side !== undefined) {
        if (typeof value.start_side !== "string" || !SIDES.includes(value.start_side)) {
            throw new Error(`${where}.start_side must be "LEFT" or "RIGHT"`);
        }
        if (comment.start_line === undefined)
            throw new Error(`${where}.start_side needs start_line`);
        comment.start_side = value.start_side;
    }
    return comment;
}
// Builds the review from the known fields only, so nothing else in the file
// reaches GitHub. The event is not an input: it is always COMMENT.
function parseReview(text, path) {
    try {
        let data;
        try {
            data = JSON.parse(text);
        }
        catch (error) {
            throw new Error(`not valid JSON: ${withoutPeriod(error.message)}`, { cause: error });
        }
        if (!isObject(data))
            throw new Error("the review must be a JSON object with body and comments");
        checkKeys(data, ["body", "comments"], "the review");
        if (!isNonEmptyString(data.body))
            throw new Error("body must be a non-empty string");
        if (!Array.isArray(data.comments))
            throw new Error("comments must be an array; use [] for no inline comments");
        return {
            body: data.body,
            comments: data.comments.map((comment, i) => parseComment(comment, `comments[${i}]`)),
        };
    }
    catch (error) {
        throw new BadInput(`--review ${path} is invalid: ${error.message}. Fix the file and run again.`);
    }
}
async function readConfig(values) {
    const missing = REQUIRED.filter((name) => !values[name]);
    if (missing.length > 0) {
        throw new BadInput(`Missing ${missing.map((name) => `--${name}`).join(", ")}. Run post-review --help for usage.`);
    }
    const { "app-id": appId, "key-file": keyFile, repo, pr, sha, review } = values;
    if (!/^[1-9]\d*$/.test(appId)) {
        throw new BadInput(`--app-id must be the App's numeric ID, not "${appId}". Find it on the App's settings page.`);
    }
    const repoMatch = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
    if (!repoMatch)
        throw new BadInput(`--repo must be owner/name, not "${repo}".`);
    const pullNumber = Number(pr);
    if (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(pullNumber)) {
        throw new BadInput(`--pr must be a pull request number, not "${pr}".`);
    }
    if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
        throw new BadInput(`--sha must be the full 40-character commit SHA the review was written against, not "${sha}".`);
    }
    const privateKey = await readInput(keyFile, "--key-file");
    checkPrivateKey(privateKey, keyFile);
    const reviewText = await readInput(review, "--review");
    return {
        appId,
        privateKey,
        repo: { owner: repoMatch[1], name: repoMatch[2] },
        pullNumber,
        sha: sha.toLowerCase(),
        review: parseReview(reviewText, review),
    };
}
function githubAdvice(status) {
    if (status === 401) {
        return "Check that --key-file belongs to the App in --app-id and that this machine's clock is correct.";
    }
    if (status === 403) {
        return "Check that the App has pull requests read and write permission and that its installation includes this repository.";
    }
    if (status === 404)
        return "Check --repo and --pr.";
    if (status === 422)
        return "Check that every comment's path and line are in the pull request diff at --sha.";
    if (status !== undefined && status >= 500)
        return "GitHub had a problem. Try again in a few minutes.";
    return "Fix the cause GitHub names and run again.";
}
function fail(output, exitCode, error) {
    output.stderr(`${JSON.stringify(error)}\n`);
    return exitCode;
}
export async function runPostReview(argv, output, options = {}) {
    let config;
    try {
        let parsed;
        try {
            parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
        }
        catch (error) {
            throw new BadInput(`${withoutPeriod(error.message)}. Run post-review --help for usage.`);
        }
        if (parsed.values.help) {
            output.stdout(USAGE);
            return 0;
        }
        config = await readConfig(parsed.values);
    }
    catch (error) {
        if (error instanceof BadInput)
            return fail(output, 2, { error: "bad_input", message: error.message });
        throw error;
    }
    try {
        const posted = await postReviewAsApp(config, options);
        output.stdout(`${JSON.stringify(posted)}\n`);
        return 0;
    }
    catch (error) {
        if (error instanceof GitHubClientError) {
            if (error.code === "head_moved") {
                return fail(output, 3, { error: "head_moved", message: error.message, current_head: error.currentHead });
            }
            if (error.code === "not_installed") {
                return fail(output, 1, { error: "not_installed", message: error.message });
            }
            return fail(output, 1, {
                error: "github_error",
                message: `${withoutPeriod(error.message)}. ${githubAdvice(error.status)}`,
                status: error.status,
            });
        }
        // fetch throws without an HTTP status when GitHub cannot be reached.
        const cause = error.cause;
        const detail = cause?.message ?? error.message;
        return fail(output, 1, {
            error: "github_error",
            message: `Could not complete the request to GitHub: ${withoutPeriod(detail)}. Check the network connection and run again.`,
        });
    }
}

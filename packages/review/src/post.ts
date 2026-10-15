// review.js post: render findings.json into inline comments and a
// summary, check every anchor against the diff, and post the review as the
// App. The validation rules and the summary text match the Python pr-review
// post; forge's watcher keys on the summary, so keep it byte-for-byte.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { postReviewAsApp, type Repo, type Review, type ReviewComment } from "../../server/src/index.js";
import { BadInput, loadConfig } from "./config.js";
import type { RunOptions } from "./review.js";

const OPTIONS = {
  workdir: { type: "string" },
  "findings-file": { type: "string" },
  "suspicions-file": { type: "string" },
  "signed-by": { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export const POST_USAGE = `Usage: review.js post --workdir <dir> --findings-file <file> [--suspicions-file <file>] --signed-by <label> [--dry-run]

Renders the findings into a COMMENT review and posts it to the pull request as
the GitHub App. Posts nothing if the pull request head is no longer the commit
gather staged. If the App already posted the same review at that commit, posts
nothing and prints that review's URL. P3 findings are dropped; P0, P1 and P2
are posted.

Options:
  --workdir <dir>           The workdir gather printed
  --findings-file <file>    JSON array of findings
  --suspicions-file <file>  JSON array of severe candidates that could not be proved
  --signed-by <label>       Who read the diff, as harness/model, e.g. Claude/Opus-5
  --dry-run                 Print the review and post nothing
  -h, --help                Show this help
`;

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
type Severity = (typeof SEVERITIES)[number];

const BADGE_COLORS: Record<Severity, string> = { P0: "red", P1: "orange", P2: "yellow", P3: "lightgrey" };

// Hidden marker proving a review came from this command, not typed by hand.
// forge's pr_watch.py requires this exact string by default; changing it here
// without changing it there breaks the clean verdict.
export const SIGNATURE = "rehanhaider/pr-review-skill";

const SIDES = ["LEFT", "RIGHT"] as const;
type Side = (typeof SIDES)[number];

export interface Finding {
  // Position in findings.json, so errors name the row the reviewer wrote.
  index: number;
  path: string;
  line?: number;
  side?: Side;
  startLine?: number;
  startSide?: Side;
  severity: Severity;
  title: string;
  body: string;
}

export interface Suspicion {
  path: string;
  line?: number;
  consequence: string;
  check: string;
}

interface State {
  repo: Repo;
  pr: number;
  headSha: string;
}

function withoutPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BadInput(`${what} ${path} does not exist. Check the path and run again.`);
    }
    throw new BadInput(`Could not read ${what} ${path}: ${withoutPeriod((error as Error).message)}.`);
  }
}

async function readJson(path: string, what: string): Promise<unknown> {
  const text = await readText(path, what);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BadInput(`${what} ${path} is not valid JSON: ${withoutPeriod((error as Error).message)}. Fix the file and run again.`);
  }
}

async function readState(workdir: string): Promise<State> {
  const path = join(workdir, "state.json");
  let state: unknown;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BadInput(`There is no state.json in ${workdir}. Pass the workdir that gather printed.`);
    }
    throw new BadInput(`Could not read ${path}: ${withoutPeriod((error as Error).message)}.`);
  }
  const { repo, pr, head_sha: headSha } = (isObject(state) ? state : {}) as Record<string, unknown>;
  const match = typeof repo === "string" ? /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo) : null;
  if (!match || !isPositiveInteger(pr) || typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new BadInput(`${path} must have repo as owner/name, pr as a number and head_sha as a full commit SHA. Run gather again.`);
  }
  return { repo: { owner: match[1] as string, name: match[2] as string }, pr, headSha };
}

function parseSide(value: unknown, where: string, errors: string[]): Side | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (SIDES as readonly string[]).includes(value)) return value as Side;
  errors.push(`${where} must be "LEFT" or "RIGHT"`);
  return undefined;
}

// Every problem in the file, not just the first, so one fix-up round is enough.
export function parseFindings(data: unknown): { findings: Finding[]; errors: string[] } {
  if (!Array.isArray(data)) return { findings: [], errors: ["the findings file must be a JSON array"] };
  const findings: Finding[] = [];
  const errors: string[] = [];
  data.forEach((row, index) => {
    const where = `finding ${index}`;
    if (!isObject(row)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const before = errors.length;
    for (const key of ["path", "severity", "title", "body"]) {
      if (!isNonEmptyString(row[key])) errors.push(`${where}: missing '${key}'`);
    }
    if (isNonEmptyString(row.severity) && !(SEVERITIES as readonly string[]).includes(row.severity)) {
      errors.push(`${where}: severity must be one of ${SEVERITIES.join(", ")}`);
    }
    if (isNonEmptyString(row.title) && Array.from(row.title.trim()).length > 120) {
      errors.push(`${where}: 'title' must be at most 120 characters`);
    }
    if (isNonEmptyString(row.body) && row.body.trim().split(/\s+/).length > 120) {
      errors.push(`${where}: 'body' must be at most 120 words`);
    }
    if (row.line !== undefined && !isPositiveInteger(row.line)) errors.push(`${where}: 'line' must be a positive integer`);
    if (row.start_line !== undefined) {
      if (row.line === undefined) {
        errors.push(`${where}: 'start_line' requires 'line'`);
      } else if (!isPositiveInteger(row.start_line)) {
        errors.push(`${where}: 'start_line' must be a positive integer`);
      } else if (isPositiveInteger(row.line) && row.start_line >= row.line) {
        errors.push(`${where}: 'start_line' must be less than 'line'`);
      }
    }
    const side = parseSide(row.side, `${where}: 'side'`, errors);
    const startSide = parseSide(row.start_side, `${where}: 'start_side'`, errors);
    if (errors.length > before) return;

    findings.push({
      index,
      path: row.path as string,
      line: row.line as number | undefined,
      side,
      startLine: row.start_line as number | undefined,
      startSide,
      severity: row.severity as Severity,
      title: row.title as string,
      body: row.body as string,
    });
  });
  return { findings, errors };
}

export function parseSuspicions(data: unknown): { suspicions: Suspicion[]; errors: string[] } {
  if (!Array.isArray(data)) return { suspicions: [], errors: ["the suspicions file must be a JSON array"] };
  const suspicions: Suspicion[] = [];
  const errors: string[] = [];
  data.forEach((row, index) => {
    const where = `suspicion ${index}`;
    if (!isObject(row)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const before = errors.length;
    for (const key of ["path", "consequence", "check"]) {
      if (!isNonEmptyString(row[key])) errors.push(`${where}: missing required non-empty '${key}'`);
    }
    if (row.line !== undefined && !isPositiveInteger(row.line)) errors.push(`${where}: 'line' must be a positive integer`);
    if (errors.length > before) return;
    suspicions.push({
      path: row.path as string,
      line: row.line as number | undefined,
      consequence: row.consequence as string,
      check: row.check as string,
    });
  });
  return { suspicions, errors };
}

// P0, P1 and P2 reach the pull request; P3 is recorded only. A finding with a
// line becomes an inline comment, ordered by severity. One without a line has
// no anchor GitHub accepts, so it goes into the summary.
export function splitFindings(findings: Finding[]): { inline: Finding[]; summary: Finding[] } {
  const posted = findings
    .filter((f) => f.severity !== "P3")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { inline: posted.filter((f) => f.line !== undefined), summary: posted.filter((f) => f.line === undefined) };
}

function badgeTitle(finding: Finding): string {
  const badge = `![${finding.severity} Badge](https://img.shields.io/badge/${finding.severity}-${BADGE_COLORS[finding.severity]}?style=flat)`;
  return `**<sub><sub>${badge}</sub></sub>  ${finding.title.trim()}**`;
}

export function renderCommentBody(finding: Finding): string {
  return `${badgeTitle(finding)}\n\n${finding.body.trim()}`;
}

export function toComment(finding: Finding): ReviewComment {
  const side = finding.side ?? "RIGHT";
  const comment: ReviewComment = { path: finding.path, line: finding.line as number, side, body: renderCommentBody(finding) };
  if (finding.startLine !== undefined) {
    comment.start_line = finding.startLine;
    comment.start_side = finding.startSide ?? side;
  }
  return comment;
}

// The review body. The verdict line follows the reviewer note, and the
// all-clear sentence appears only with no posted findings and no suspicions:
// automation reads it as ready to merge.
export function renderSummary(
  headSha: string,
  posted: Finding[],
  summaryFindings: Finding[],
  reviewer: string,
  suspicions: Suspicion[],
): string {
  const lines = ["> [!NOTE]", `> 🤖 Reviewed by ${reviewer.trim()}`, ""];
  const sha = headSha.slice(0, 10);
  if (posted.length > 0) {
    const parts = SEVERITIES.map((s) => [s, posted.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    const noun = posted.length === 1 ? "finding" : "findings";
    lines.push(`Reviewed \`${sha}\` — ${posted.length} ${noun} (${parts.join(", ")}).`);
  } else if (suspicions.length > 0) {
    lines.push(`Reviewed \`${sha}\` — no findings, ${suspicions.length} unverified.`);
  } else {
    lines.push(`Reviewed \`${sha}\` — no new issues found.`);
  }
  if (summaryFindings.length > 0) {
    lines.push("", "Findings without a line:");
    for (const f of summaryFindings) {
      const body = f.body.trim().split("\n").map((line) => (line.trim() ? `  ${line}` : ""));
      lines.push("", `- \`${f.path}\` ${badgeTitle(f)}`, "", ...body);
    }
  }
  if (suspicions.length > 0) {
    lines.push("", "Unverified — severe if real, could not be proved:", "");
    for (const s of suspicions) {
      const loc = s.line ? `\`${s.path}:${s.line}\`` : `\`${s.path}\``;
      lines.push(`- ${loc} — ${s.consequence.trim()} Check: ${s.check.trim()}`);
    }
  }
  // Last and invisible: a reader never sees it, and a person typing a review
  // by hand does not know to add it.
  lines.push("", `<!-- ${SIGNATURE} -->`);
  return `${lines.join("\n")}\n`;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function diffPath(header: string, prefix: string): string | null {
  const target = header.slice(4).split("\t")[0] as string;
  if (target === "/dev/null") return null;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}

// path -> the lines GitHub accepts comments on: added and context lines on
// RIGHT in new-file numbering, deleted and context lines on LEFT in old-file
// numbering. A deleted file keeps its old path.
export function commentableLines(diff: string): Map<string, Record<Side, Set<number>>> {
  const files = new Map<string, Record<Side, Set<number>>>();
  let current: Record<Side, Set<number>> | undefined;
  let oldPath: string | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  // Like Python's splitlines: a final newline does not start an empty line,
  // which the hunk walk would take for a context line.
  const rows = diff.split(/\r?\n/);
  if (rows.at(-1) === "") rows.pop();
  for (const raw of rows) {
    if (raw.startsWith("diff --git")) {
      inHunk = false;
      current = undefined;
      oldPath = null;
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = current !== undefined;
      continue;
    }
    if (inHunk && current) {
      if (raw.startsWith("+")) {
        current.RIGHT.add(newNo++);
      } else if (raw.startsWith("-")) {
        current.LEFT.add(oldNo++);
      } else if (!raw.startsWith("\\")) {
        // Context: " ", or "" when trailing whitespace was stripped.
        current.RIGHT.add(newNo++);
        current.LEFT.add(oldNo++);
      }
    } else if (raw.startsWith("--- ")) {
      oldPath = diffPath(raw, "a/");
    } else if (raw.startsWith("+++ ")) {
      const path = diffPath(raw, "b/") ?? oldPath;
      if (path === null) {
        current = undefined;
      } else {
        current = files.get(path) ?? { LEFT: new Set(), RIGHT: new Set() };
        files.set(path, current);
      }
    }
  }
  return files;
}

// One error per anchor outside the diff. The reviews endpoint is atomic: one
// bad anchor fails the whole POST with a 422.
export function checkAnchors(findings: Finding[], diff: string): string[] {
  const files = commentableLines(diff);
  const errors: string[] = [];
  for (const f of findings) {
    const side = f.side ?? "RIGHT";
    const anchors: Array<[number, Side]> = [[f.line as number, side]];
    if (f.startLine !== undefined) anchors.push([f.startLine, f.startSide ?? side]);
    for (const [line, anchorSide] of anchors) {
      const file = files.get(f.path);
      const valid = file?.[anchorSide] ?? new Set<number>();
      if (valid.has(line)) continue;
      const where = `finding ${f.index} (${f.path}:${line}`;
      if (!file) {
        errors.push(`${where}): file is not in the PR diff`);
      } else if (valid.size === 0) {
        errors.push(`${where}): no commentable ${anchorSide} lines in this file's hunks`);
      } else {
        const nearest = [...valid].reduce((a, b) => (Math.abs(b - line) < Math.abs(a - line) ? b : a));
        errors.push(`${where}, ${anchorSide}): line is not part of the diff; nearest commentable ${anchorSide} line is ${nearest}`);
      }
    }
  }
  return errors;
}

function refuse(what: string, errors: string[]): never {
  throw new BadInput(`Refusing to post: ${what}: ${errors.join("; ")}. Fix the file and run again.`);
}

// Returns the text to print: the usage, the dry-run review, or the review URL.
export async function post(argv: string[], options: RunOptions): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  } catch (error) {
    throw new BadInput(`${withoutPeriod((error as Error).message)}. Run review.js post --help for usage.`);
  }
  const values = parsed.values;
  if (values.help) return POST_USAGE;
  const missing = (["workdir", "findings-file", "signed-by"] as const).filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new BadInput(`Missing ${missing.map((name) => `--${name}`).join(", ")}. Run review.js post --help for usage.`);
  }
  const signedBy = values["signed-by"] as string;
  if (signedBy.trim() === "" || /[\r\n]/.test(signedBy)) {
    throw new BadInput("--signed-by needs a one-line harness/model label, e.g. Claude/Opus-5.");
  }

  const cwd = options.cwd ?? process.cwd();
  const workdir = resolve(cwd, values.workdir as string);
  const state = await readState(workdir);

  const findingsFile = resolve(cwd, values["findings-file"] as string);
  const { findings, errors } = parseFindings(await readJson(findingsFile, "--findings-file"));
  if (errors.length > 0) refuse(`invalid findings in ${findingsFile}`, errors);

  let suspicions: Suspicion[] = [];
  if (values["suspicions-file"] !== undefined) {
    const suspicionsFile = resolve(cwd, values["suspicions-file"]);
    const parsedSuspicions = parseSuspicions(await readJson(suspicionsFile, "--suspicions-file"));
    if (parsedSuspicions.errors.length > 0) refuse(`invalid suspicions in ${suspicionsFile}`, parsedSuspicions.errors);
    suspicions = parsedSuspicions.suspicions;
  }

  const { inline, summary } = splitFindings(findings);
  // diff.patch is the diff at head_sha, and the post is refused unless the
  // head is still head_sha. Without it, as when GitHub refused a large diff,
  // GitHub itself refuses a bad anchor with a 422.
  if (inline.length > 0) {
    let diff: string | undefined;
    try {
      diff = await readFile(join(workdir, "diff.patch"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new BadInput(`Could not read ${join(workdir, "diff.patch")}: ${withoutPeriod((error as Error).message)}.`);
      }
    }
    if (diff !== undefined) {
      const anchorErrors = checkAnchors(inline, diff);
      if (anchorErrors.length > 0) refuse("comment anchors outside the diff, so the whole review would fail", anchorErrors);
    }
  }

  const review: Review = {
    body: renderSummary(state.headSha, [...inline, ...summary], summary, signedBy, suspicions),
    comments: inline.map(toComment),
  };

  if (values["dry-run"]) {
    return `${JSON.stringify({ commit_id: state.headSha, event: "COMMENT", body: review.body, comments: review.comments }, null, 2)}\n`;
  }

  const config = await loadConfig(options.home);
  const posted = await postReviewAsApp(
    { appId: config.appId, privateKey: config.privateKey, repo: state.repo, pullNumber: state.pr, sha: state.headSha, review },
    options,
  );
  return `${posted.html_url}\n`;
}

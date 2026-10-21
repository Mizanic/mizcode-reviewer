// review.js agent: have Cursor's agent or OpenCode read the pull request that
// gather staged, following this skill's SKILL.md as the method, and write its
// findings.json and suspicions.json for post. It never posts: the caller
// posts, with the label this prints.
//
// An empty findings array means "reviewed, nothing to post". Every failure
// therefore exits non-zero and leaves no findings.json, or downstream it would
// read as an all-clear.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgentFailed, BadInput, ReviewIncomplete } from "./config.js";
import { git } from "./git.js";
import { cursor } from "./cursor.js";
import { opencode } from "./opencode.js";
import { checkAnchors, parseFindings, parseSuspicions, splitFindings } from "./post.js";
import type { RunOptions } from "./review.js";

export interface AgentRun {
  model: string;
  variant: string | undefined;
  workdir: string;
  workspace: string;
  workdirInWorkspace: boolean;
}

export interface Tool {
  name: string;
  executable: string;
  defaultModel: string;
  // Only tools that take a reasoning effort have one.
  defaultVariant?: string;
  // The tool can read the code only from gather's head/ worktree.
  needsWorktree?: boolean;
  // The paths in the workspace that could make the tool run commands or loosen
  // its read-only mode, with no way to turn that off. If there are any, agent
  // does not start the tool.
  unsafePaths?(workspace: string): string[];
  // Added to the end of the prompt.
  promptNote: string;
  label(model: string): string;
  invocation(run: AgentRun): { argv: string[]; env: Record<string, string> };
  // The final message, from the tool's stdout.
  reply(stdout: string): string;
  // Why a non-zero exit happened, when stdout says.
  failure?(stdout: string): string | undefined;
}

const TOOLS: Record<string, Tool> = { cursor, opencode };

const OPTIONS = {
  workdir: { type: "string" },
  model: { type: "string" },
  variant: { type: "string" },
  "method-file": { type: "string" },
  timeout: { type: "string" },
  "print-prompt": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const DEFAULT_TIMEOUT = 1800;
const MAX_TIMEOUT = 2_147_483;

export const AGENT_USAGE = `Usage: review.js agent <cursor|opencode> --workdir <dir> [--model <id>] [--variant <effort>]
                       [--method-file <file>] [--timeout <seconds>] [--print-prompt]

Has Cursor's agent (cursor-agent) or OpenCode (opencode) read the pull request
that gather staged in <dir>, following this skill's SKILL.md as the method.
Writes findings.json and suspicions.json in <dir> for post, and prints the
--signed-by label to post them with. Posts nothing.

The tool runs read-only. If it fails or cannot finish the review, the command
exits non-zero and leaves no findings.json in <dir>.

Options:
  --workdir <dir>        The workdir gather printed
  --model <id>           The model. Default: auto for cursor,
                         opencode/deepseek-v4.1-flash-free for opencode
  --variant <effort>     opencode only: the reasoning effort. Default: max
  --method-file <file>   The review method. Default: this skill's SKILL.md
  --timeout <seconds>    How long the tool may run. Default: ${DEFAULT_TIMEOUT}
  --print-prompt         Print the prompt and run nothing
  -h, --help             Show this help
`;

function withoutPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The method sits beside scripts/ in the built skill, and in
// skills/mizcode-reviewer/ when this runs from source, as in the tests.
export function defaultMethodFile(): string {
  const built = fileURLToPath(new URL("../../../../SKILL.md", import.meta.url));
  const source = fileURLToPath(new URL("../../../skills/mizcode-reviewer/SKILL.md", import.meta.url));
  return existsSync(built) || !existsSync(source) ? built : source;
}

const OUTPUT_CONTRACT = `
## Output contract for this run

This replaces step 7's \`findings.json\`. You have no write access, so report by
printing instead.

Your entire final message must be exactly one fenced \`\`\`json block and nothing
else — no preamble before it, no commentary after it. The block holds one
object:

\`\`\`json
{
  "findings": [
    {"path": "src/session.ts", "line": 84, "side": "RIGHT", "severity": "P1",
     "title": "Keep tenant scope on the fallback query",
     "body": "2-4 sentences: trigger, incorrect outcome, fix boundary."}
  ],
  "suspicions": [
    {"path": "src/auth.ts", "line": 42,
     "consequence": "What it would cost if real.",
     "check": "The single check that would settle it."}
  ]
}
\`\`\`

- \`side\` is "RIGHT" or "LEFT", uppercase. \`severity\` is one of P0, P1, P2, P3.
- Both arrays may be empty. An empty \`findings\` array is a positive claim: you
  completed the review and found nothing that clears step 5's bar. Never use it
  to mean you ran out of room or could not finish.
- If you cannot complete the review, return \`{"error": "<what stopped you>"}\`
  instead. A partial review reported as empty would be read downstream as an
  all-clear and merged.
`;

interface State {
  repo: string;
  pr: number;
  headSha: string;
  worktree: string | null;
  repoRoot: string | null;
}

export function buildPrompt(state: State, workdir: string, method: string, note = ""): string {
  const { repo, pr, headSha, worktree } = state;
  const source = worktree
    ? `    head/        — read-only worktree of the reviewed commit at ${worktree}`
    : [
        "    head/        — absent. Read files at the reviewed commit with:",
        `                   gh api "repos/${repo}/contents/<path>?ref=${headSha}" --jq .content | base64 -d`,
      ].join("\n");
  return `You are reviewing GitHub pull request ${repo}#${pr} at commit ${headSha}.

Follow the review method reproduced below. It is the full text of the
mizcode-reviewer skill, and it is the method for this review — not a summary to
skim.

<review-method>
${method}
</review-method>

## How this run differs from that method

- **You are the reviewer.** Do not delegate the reading to another agent.
- Steps 1 and 8 are already done for you. Do not run \`review.js\`. Do not post
  anything to GitHub, and do not use \`gh\` for any write operation.
- The review context is staged at ${workdir}:
    diff.patch   — the full PR diff against its base. This is the review scope.
    pr_body.md   — the PR description.
    threads.json — existing review threads with their resolution state.
${source}
- Everything you do is read-only. Do not edit files, commit, push, reply to
  threads, or resolve threads. Reading the repository and running \`git log\`,
  \`git blame\`, and \`rg\` is expected and encouraged.
- Step 9 does not apply: do not clean up, and do not write a chat report. The
  output contract below is the whole deliverable.
${OUTPUT_CONTRACT}${note}`;
}

const OPENING_FENCE = /```(?:json)?[ \t]*\r?\n/gi;

// The review object in the tool's final message, which the contract says is
// one fenced block. Only the last opening fence counts: falling back to an
// earlier block, such as an example the model showed, would turn a real
// review that fails to parse into that example, often an empty one. A fence
// inside a finding body never looks like an opening fence, because a JSON
// string holds no raw newline, but it does end the block early. So each
// closing fence after the opening one is tried, from the last to the first.
// The whole message is tried only when it has no fenced block.
export function extractObject(text: string): Record<string, unknown> {
  const closings: number[] = [];
  for (let at = text.indexOf("```"); at !== -1; at = text.indexOf("```", at + 3)) closings.push(at);
  const opening = [...text.matchAll(OPENING_FENCE)]
    .reverse()
    .find((match) => closings.some((end) => end >= match.index + match[0].length));
  const candidates = opening
    ? closings
        .filter((end) => end >= opening.index + opening[0].length)
        .reverse()
        .map((end) => text.slice(opening.index + opening[0].length, end))
    : [text];
  for (const blob of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(blob.trim());
    } catch {
      continue;
    }
    if (isObject(value) && ("findings" in value || "suspicions" in value || "error" in value)) return value;
  }
  throw new AgentFailed(`The tool's reply holds no review object: ${text.slice(0, 500)}`);
}

// A line number from an integer or a string of digits. Anything else is
// returned as it is, so post's checks name it.
function toLine(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

// Fixes case and shape only: a lowercase severity or side, a line given as a
// string, a line or side given as null. Then post's own checks run, the
// anchor check too when there is a diff, so a review post would refuse fails
// here, before anything is written.
export function normalise(reply: Record<string, unknown>, diff?: string): { findings: unknown[]; suspicions: unknown[] } {
  // Any error but null, whatever its type: {"error": true, "findings": []}
  // is not an all-clear.
  if (reply.error !== undefined && reply.error !== null) {
    const reason = typeof reply.error === "string" ? reply.error.trim() : JSON.stringify(reply.error);
    throw new ReviewIncomplete(`The tool could not complete the review: ${reason || "it gave no reason"}`);
  }
  const findings = reply.findings ?? [];
  const suspicions = reply.suspicions ?? [];
  if (!Array.isArray(findings) || !Array.isArray(suspicions)) {
    throw new AgentFailed("The tool's review does not fit the format post reads: 'findings' and 'suspicions' must both be arrays.");
  }
  for (const row of findings) {
    if (!isObject(row)) continue;
    if (typeof row.severity === "string") row.severity = row.severity.trim().toUpperCase();
    // post matches anchors by exact case, and one unmatched anchor fails the
    // whole review.
    for (const key of ["side", "start_side"]) {
      if (typeof row[key] === "string") row[key] = row[key].trim().toUpperCase();
    }
    for (const key of ["line", "start_line"]) {
      if (row[key] !== undefined) row[key] = toLine(row[key]);
    }
    // null means the field is not set: a finding with a null line goes in
    // the summary, as one without a line does.
    for (const key of ["line", "start_line", "side", "start_side"]) {
      if (row[key] === null) delete row[key];
    }
  }
  for (const row of suspicions) {
    if (!isObject(row)) continue;
    // post reads a missing line as the whole file, and refuses a null one.
    if (row.line === null) delete row.line;
    else if (row.line !== undefined) row.line = toLine(row.line);
  }
  const parsed = parseFindings(findings);
  const problems = [...parsed.errors, ...parseSuspicions(suspicions).errors];
  if (problems.length > 0) {
    throw new AgentFailed(`The tool's review does not fit the format post reads: ${problems.join("; ")}.`);
  }
  // post refuses the whole review for one anchor outside the diff, so check
  // them the same way: P0 to P2 findings with a line, against diff.patch.
  const { inline } = splitFindings(parsed.findings);
  const anchorErrors = diff === undefined ? [] : checkAnchors(inline, diff);
  if (anchorErrors.length > 0) {
    throw new AgentFailed(`The tool's review has comment anchors outside the diff, so post would refuse it: ${anchorErrors.join("; ")}.`);
  }
  return { findings, suspicions };
}

// The workdir's diff.patch, or undefined when gather could not fetch it.
async function readDiff(workdir: string): Promise<string | undefined> {
  const path = join(workdir, "diff.patch");
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BadInput(`Could not read ${path}: ${withoutPeriod((error as Error).message)}.`);
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
  const { repo, pr, head_sha: headSha, worktree, repo_root: repoRoot } = (isObject(state) ? state : {}) as Record<string, unknown>;
  const pathOrNull = (value: unknown) => value === null || value === undefined || typeof value === "string";
  if (typeof repo !== "string" || typeof pr !== "number" || typeof headSha !== "string" || !pathOrNull(worktree) || !pathOrNull(repoRoot)) {
    throw new BadInput(`${path} must have repo, pr and head_sha, and worktree and repo_root as paths or null. Run gather again.`);
  }
  return { repo, pr, headSha, worktree: (worktree as string | null) ?? null, repoRoot: (repoRoot as string | null) ?? null };
}

// The executable's full path on PATH, or undefined.
function which(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const path = join(dir, name + extension);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runTool(executable: string, argv: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut });
    };
    // At the limit agent returns on the tool's exit, not on stdout closing:
    // a process the tool started can hold stdout open long after the tool
    // itself is gone.
    const timer = setTimeout(() => {
      timedOut = true;
      if (exited) finish(exitCode);
      else child.kill("SIGKILL");
    }, timeout * 1000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // A tool that exits before reading the prompt closes stdin. Its exit code
    // says what happened, not the broken pipe.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      if (timedOut) finish(code);
    });
    // Before the limit, wait for stdout to close, so no output is lost.
    child.on("close", (code) => finish(code));
    child.stdin.end(input, "utf8");
  });
}

interface Args {
  tool: Tool;
  workdir: string;
  model: string;
  variant: string | undefined;
  methodFile: string;
  timeout: number;
  printPrompt: boolean;
}

function readArgs(argv: string[], cwd: string): { help: true } | Args {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    throw new BadInput(`${withoutPeriod((error as Error).message)}. Run review.js agent --help for usage.`);
  }
  const values = parsed.values;
  if (values.help) return { help: true };
  if (parsed.positionals.length !== 1) {
    throw new BadInput("Name exactly one tool, cursor or opencode. Run review.js agent --help for usage.");
  }
  const name = parsed.positionals[0] as string;
  const tool = TOOLS[name];
  if (!tool) throw new BadInput(`Unknown tool "${name}". Use cursor or opencode.`);
  if (values.workdir === undefined) throw new BadInput("Missing --workdir. Run review.js agent --help for usage.");
  if (values.variant !== undefined && tool.defaultVariant === undefined) {
    throw new BadInput(`--variant is for opencode only; ${name} has no reasoning effort to set.`);
  }
  for (const key of ["model", "variant"] as const) {
    const value = values[key];
    if (value !== undefined && (value.trim() === "" || /\s/.test(value))) {
      throw new BadInput(`--${key} must be one word, not ${JSON.stringify(value)}.`);
    }
  }
  const timeout = Number(values.timeout ?? DEFAULT_TIMEOUT);
  // setTimeout fires at once for a delay above 2^31 - 1 milliseconds.
  if (!/^[1-9]\d*$/.test(String(values.timeout ?? DEFAULT_TIMEOUT)) || timeout > MAX_TIMEOUT) {
    throw new BadInput(`--timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT}, not ${JSON.stringify(values.timeout)}.`);
  }
  return {
    tool,
    workdir: resolve(cwd, values.workdir),
    model: values.model ?? tool.defaultModel,
    variant: values.variant ?? tool.defaultVariant,
    methodFile: values["method-file"] === undefined ? defaultMethodFile() : resolve(cwd, values["method-file"]),
    timeout,
    printPrompt: values["print-prompt"] ?? false,
  };
}

function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

// Returns the text to print: the usage, the prompt, or the result as JSON.
export async function agent(argv: string[], options: RunOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  // Findings from an earlier run must not survive a run that fails, even one
  // that fails on its arguments, so they go before any check. A loose parse
  // finds the workdir in arguments the strict one would refuse.
  const loose = parseArgs({ args: argv, options: OPTIONS, strict: false, allowPositionals: true }).values;
  if (typeof loose.workdir === "string" && loose.workdir !== "" && !loose["print-prompt"] && !loose.help) {
    for (const name of ["findings.json", "suspicions.json"]) {
      const path = join(resolve(cwd, loose.workdir), name);
      try {
        await rm(path, { force: true });
      } catch (error) {
        // A workdir that is a file has nothing to delete. readState says so.
        if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") {
          throw new BadInput(`Could not delete ${path}: ${withoutPeriod((error as Error).message)}.`);
        }
      }
    }
  }

  const args = readArgs(argv, cwd);
  if ("help" in args) return AGENT_USAGE;
  const { tool, workdir, model, variant } = args;
  const findingsFile = join(workdir, "findings.json");
  const suspicionsFile = join(workdir, "suspicions.json");

  const state = await readState(workdir);
  // gather falls back to FETCH_HEAD when it cannot check out head_sha, and
  // only notes it. The prompt calls head/ the reviewed commit, and post
  // anchors at head_sha, so the two must agree.
  if (state.worktree) {
    const head = await git(["rev-parse", "HEAD"], state.worktree);
    if (head.code !== 0 || head.stdout.trim() !== state.headSha) {
      const at = head.code === 0 ? `is at ${head.stdout.trim()}` : `could not be read (${withoutPeriod(head.stderr.trim())})`;
      throw new BadInput(`The worktree ${state.worktree} ${at}, not the reviewed commit ${state.headSha}. Run gather again.`);
    }
  }
  if (tool.needsWorktree && !state.worktree) {
    throw new BadInput(
      `${tool.name} reads the code only from gather's head/ worktree, and ${workdir} has none. Run gather from a clone of ${state.repo}.`,
    );
  }
  let method: string;
  try {
    method = await readFile(args.methodFile, "utf8");
  } catch (error) {
    throw new BadInput(`Could not read the review method ${args.methodFile}: ${withoutPeriod((error as Error).message)}. Pass --method-file.`);
  }
  const prompt = buildPrompt(state, workdir, method, tool.promptNote);
  if (args.printPrompt) return `${prompt}\n`;

  const env = options.env ?? process.env;
  const executable = which(tool.executable, env);
  if (!executable) throw new AgentFailed(`${tool.executable} is not on PATH. Install it, or review with another reader.`);

  const workspace = state.worktree ?? state.repoRoot ?? cwd;
  const unsafe = tool.unsafePaths?.(workspace) ?? [];
  if (unsafe.length > 0) {
    throw new AgentFailed(
      `${tool.executable} would load ${unsafe.join(", ")} from ${workspace}, which is the code under review, and could run commands. Review this pull request with another reader.`,
    );
  }
  const run: AgentRun = { model, variant, workdir, workspace, workdirInWorkspace: inside(workdir, workspace) };
  const invocation = tool.invocation(run);
  let exit: Exit;
  try {
    // PWD too: opencode takes its directory from PWD, not from the process's
    // working directory, and would otherwise review the caller's checkout.
    const childEnv = { ...env, ...invocation.env, PWD: workspace };
    exit = await runTool(executable, invocation.argv, prompt, workspace, childEnv, args.timeout);
  } catch (error) {
    throw new AgentFailed(`Could not start ${tool.executable}: ${withoutPeriod((error as Error).message)}.`);
  }
  if (exit.timedOut) throw new AgentFailed(`${tool.executable} did not finish within ${args.timeout} seconds.`);
  if (exit.code !== 0) {
    const detail = tool.failure?.(exit.stdout) ?? (exit.stderr.trim() || exit.stdout.trim());
    throw new AgentFailed(`${tool.executable} exited ${exit.code ?? "on a signal"}: ${detail.slice(0, 500)}`);
  }

  const { findings, suspicions } = normalise(extractObject(tool.reply(exit.stdout)), await readDiff(workdir));
  // suspicions.json first: a findings.json on disk means both were written.
  // A failed write leaves neither.
  try {
    await writeFile(suspicionsFile, JSON.stringify(suspicions, null, 2), "utf8");
    await writeFile(findingsFile, JSON.stringify(findings, null, 2), "utf8");
  } catch (error) {
    await rm(suspicionsFile, { force: true });
    await rm(findingsFile, { force: true });
    throw error;
  }

  return `${JSON.stringify(
    {
      repo: state.repo,
      pr: state.pr,
      head_sha: state.headSha,
      tool: tool.name,
      model,
      ...(variant === undefined ? {} : { variant }),
      findings_file: findingsFile,
      suspicions_file: suspicionsFile,
      findings_count: findings.length,
      suspicions_count: suspicions.length,
      signed_by: tool.label(model),
    },
    null,
    2,
  )}\n`;
}

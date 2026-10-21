import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt, extractObject, normalise } from "../src/agent.js";
import { prettyModel } from "../src/cursor.js";
import { READ_ONLY_BASH, SHELL_NOTE, opencodeLabel, opencodeReply } from "../src/opencode.js";
import { newDir, run } from "./helpers.js";

const sha = "1e43c532b81527f0c71614b8220c3ea8436710d9";

const diffText = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,3 @@",
  " kept",
  "+new two",
  "+new three",
  "",
].join("\n");

const finding = {
  path: "src/app.ts",
  line: 3,
  side: "RIGHT",
  severity: "P1",
  title: "Keep tenant scope on the fallback query",
  body: "When the primary lookup misses, this fallback queries by email alone.",
};
const suspicion = { path: "src/auth.ts", line: 42, consequence: "Every admin is locked out.", check: "Log one claim." };

// A workdir as gather leaves it, with a head/ worktree directory.
function staged(state: Record<string, unknown> = {}) {
  const workdir = newDir("workdir");
  const worktree = join(workdir, "head");
  mkdirSync(worktree);
  writeFileSync(
    join(workdir, "state.json"),
    JSON.stringify({ repo: "acme/widgets", pr: 7, head_sha: sha, base: "main", workdir, worktree, repo_root: "/repo", ...state }),
  );
  writeFileSync(join(workdir, "diff.patch"), diffText);
  return { workdir, worktree };
}

const method = (() => {
  const path = join(newDir("method"), "SKILL.md");
  writeFileSync(path, "THE REVIEW METHOD\n");
  return path;
})();

interface Fake {
  stdout: string;
  exit?: number;
  stderr?: string;
  sleep?: number;
}

// A fake cursor-agent or opencode on PATH. It records its argv, cwd, stdin
// and OPENCODE_CONFIG_CONTENT, then prints what it was given.
function fakeTool(name: string, fake: Fake) {
  const dir = newDir("bin");
  const record = join(dir, "record.json");
  writeFileSync(join(dir, "fake.json"), JSON.stringify(fake));
  const script = join(dir, name);
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const fake = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "fake.json"))}, "utf8"));
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), input, config: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  }));
  setTimeout(() => {
    process.stdout.write(fake.stdout);
    if (fake.stderr) process.stderr.write(fake.stderr);
    process.exit(fake.exit ?? 0);
  }, (fake.sleep ?? 0) * 1000);
});
`,
  );
  chmodSync(script, 0o755);
  // The fake must not shadow the real tool by accident, and must find node.
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
  const recorded = () =>
    JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; cwd: string; input: string; config: string | null };
  return { env, recorded };
}

const cursorEnvelope = (result: string, isError = false) => JSON.stringify({ type: "result", is_error: isError, result });
const fenced = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const ocText = (message: string, text: string) => JSON.stringify({ type: "text", part: { messageID: message, type: "text", text } });
const ocStep = (message: string, reason = "stop") => JSON.stringify({ type: "step_finish", part: { messageID: message, reason } });
const ocError = (message: string) => JSON.stringify({ type: "error", error: { type: "provider.no-route", message } });

function agent(argv: string[], env: NodeJS.ProcessEnv) {
  return run(["agent", ...argv], { env, cwd: newDir("cwd") });
}

function written(workdir: string) {
  return {
    findings: existsSync(join(workdir, "findings.json")) ? JSON.parse(readFileSync(join(workdir, "findings.json"), "utf8")) : undefined,
    suspicions: existsSync(join(workdir, "suspicions.json"))
      ? JSON.parse(readFileSync(join(workdir, "suspicions.json"), "utf8"))
      : undefined,
  };
}

describe("agent cursor", () => {
  it("writes findings.json and suspicions.json and prints the label", async () => {
    const { workdir, worktree } = staged();
    const { env, recorded } = fakeTool("cursor-agent", {
      stdout: cursorEnvelope(fenced({ findings: [finding], suspicions: [suspicion] })),
    });
    const { code, stdout, stderr } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      repo: "acme/widgets",
      pr: 7,
      head_sha: sha,
      tool: "cursor",
      model: "auto",
      findings_file: join(workdir, "findings.json"),
      suspicions_file: join(workdir, "suspicions.json"),
      findings_count: 1,
      suspicions_count: 1,
      signed_by: "Cursor/Auto",
    });
    expect(written(workdir)).toEqual({ findings: [finding], suspicions: [suspicion] });

    const call = recorded();
    expect(call.argv).toEqual([
      "--model", "auto", "--mode", "ask", "--trust", "--print", "--output-format", "json", "--workspace", worktree,
      // gather puts head/ inside the workdir, so the workdir is outside it.
      "--add-dir", workdir,
    ]);
    expect(call.cwd).toBe(worktree);
    expect(call.input).toContain("THE REVIEW METHOD");
    expect(call.input).toContain(`acme/widgets#7 at commit ${sha}`);
    expect(call.input).not.toContain("## Shell in this run");
  });

  it("works in repo_root without a worktree and adds no workdir inside it", async () => {
    const repoRoot = newDir("repo");
    const workdir = join(repoRoot, "workdir");
    mkdirSync(workdir);
    writeFileSync(join(workdir, "state.json"), JSON.stringify({ repo: "acme/widgets", pr: 7, head_sha: sha, worktree: null, repo_root: repoRoot }));
    const { env, recorded } = fakeTool("cursor-agent", { stdout: cursorEnvelope(fenced({ findings: [] })) });
    const { code } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(0);
    expect(recorded().cwd).toBe(repoRoot);
    expect(recorded().argv.slice(-2)).toEqual(["--workspace", repoRoot]);
    expect(recorded().input).toContain(`gh api "repos/acme/widgets/contents/<path>?ref=${sha}"`);
  });

  it("writes an empty review as two empty arrays", async () => {
    const { workdir } = staged();
    const { env } = fakeTool("cursor-agent", { stdout: cursorEnvelope(fenced({ findings: [], suspicions: [] })) });
    const { code, stdout } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).findings_count).toBe(0);
    expect(written(workdir)).toEqual({ findings: [], suspicions: [] });
  });

  it("writes findings that post accepts", async () => {
    const { workdir } = staged();
    const reply = { findings: [{ ...finding, side: "right", severity: "p1", line: "3" }], suspicions: [{ ...suspicion, line: null }] };
    const { env } = fakeTool("cursor-agent", { stdout: cursorEnvelope(fenced(reply)) });
    const { code } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(0);
    const fileLevel = { path: suspicion.path, consequence: suspicion.consequence, check: suspicion.check };
    expect(written(workdir)).toEqual({ findings: [finding], suspicions: [fileLevel] });

    const posted = await run(
      ["post", "--workdir", workdir, "--findings-file", join(workdir, "findings.json"),
        "--suspicions-file", join(workdir, "suspicions.json"), "--signed-by", "Cursor/Auto", "--dry-run"],
      {},
    );
    expect(posted.stderr).toBe("");
    expect(posted.code).toBe(0);
    expect(JSON.parse(posted.stdout).comments).toHaveLength(1);
  });

  it("labels the review with the model that ran", async () => {
    const { workdir } = staged();
    const { env, recorded } = fakeTool("cursor-agent", { stdout: cursorEnvelope(fenced({ findings: [] })) });
    const { code, stdout } = await agent(["cursor", "--workdir", workdir, "--method-file", method, "--model", "grok-4-7"], env);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ model: "grok-4-7", signed_by: "Cursor/Grok-4.7" });
    expect(recorded().argv.slice(0, 2)).toEqual(["--model", "grok-4-7"]);
  });

  it("exits 5 and writes no findings when the tool could not finish", async () => {
    const { workdir } = staged();
    // Findings left by an earlier run must not survive.
    writeFileSync(join(workdir, "findings.json"), "[]");
    writeFileSync(join(workdir, "suspicions.json"), "[]");
    const { env } = fakeTool("cursor-agent", {
      stdout: cursorEnvelope(fenced({ error: "the diff was truncated", findings: [] })),
    });
    const { code, stdout, error } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(5);
    expect(stdout).toBe("");
    expect(error).toEqual({ error: "review_incomplete", message: "The tool could not complete the review: the diff was truncated" });
    expect(written(workdir)).toEqual({ findings: undefined, suspicions: undefined });
  });

  it.each([
    ["an error envelope", { stdout: cursorEnvelope("rate limited", true) }, "cursor-agent reported an error: rate limited"],
    ["a bare line", { stdout: "Error: [internal]" }, "cursor-agent did not print a JSON envelope: Error: [internal]"],
    ["no output", { stdout: "" }, "cursor-agent printed nothing"],
    ["an empty result", { stdout: cursorEnvelope("  ") }, "cursor-agent returned an empty result"],
    ["a reply with no review object", { stdout: cursorEnvelope("I could not access the diff.") }, "holds no review object"],
    ["a non-zero exit", { stdout: "", stderr: "not signed in", exit: 2 }, "cursor-agent exited 2: not signed in"],
    [
      "a finding post would refuse",
      { stdout: cursorEnvelope(fenced({ findings: [{ ...finding, title: undefined }] })) },
      "does not fit the format post reads: finding 0: missing 'title'",
    ],
    [
      "an unknown severity",
      { stdout: cursorEnvelope(fenced({ findings: [{ ...finding, severity: "critical" }] })) },
      "finding 0: severity must be one of P0, P1, P2, P3",
    ],
    [
      "a line that is not a number",
      { stdout: cursorEnvelope(fenced({ findings: [{ ...finding, line: "near the top" }] })) },
      "finding 0: 'line' must be a positive integer",
    ],
    [
      "a boolean line",
      { stdout: cursorEnvelope(fenced({ findings: [{ ...finding, line: true }] })) },
      "finding 0: 'line' must be a positive integer",
    ],
    [
      "findings that are not an array",
      { stdout: cursorEnvelope(fenced({ findings: { path: "src/app.ts" } })) },
      "'findings' and 'suspicions' must both be arrays",
    ],
  ])("exits 1 with agent_error and writes no findings on %s", async (_, fake, message) => {
    const { workdir } = staged();
    writeFileSync(join(workdir, "findings.json"), "[]");
    const { env } = fakeTool("cursor-agent", fake);
    const { code, stdout, error } = await agent(["cursor", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(error?.error).toBe("agent_error");
    expect(String(error?.message)).toContain(message);
    expect(written(workdir)).toEqual({ findings: undefined, suspicions: undefined });
  });

  it("exits 1 when the tool runs past --timeout", async () => {
    const { workdir } = staged();
    const { env } = fakeTool("cursor-agent", { stdout: cursorEnvelope(fenced({ findings: [] })), sleep: 30 });
    const { code, error } = await agent(["cursor", "--workdir", workdir, "--method-file", method, "--timeout", "1"], env);

    expect(code).toBe(1);
    expect(error).toEqual({ error: "agent_error", message: "cursor-agent did not finish within 1 seconds." });
    expect(written(workdir).findings).toBeUndefined();
  });

  it("exits 1 when the tool is not on PATH", async () => {
    const { workdir } = staged();
    const { code, error } = await agent(["cursor", "--workdir", workdir, "--method-file", method], { PATH: newDir("empty") });

    expect(code).toBe(1);
    expect(error).toEqual({
      error: "agent_error",
      message: "cursor-agent is not on PATH. Install it, or review with another reader.",
    });
  });
});

describe("agent opencode", () => {
  it("runs read-only with the default model and reads the last message", async () => {
    const { workdir, worktree } = staged();
    const stdout = [
      ocText("m1", "Checking the diff first."),
      ocStep("m1", "tool-calls"),
      ocText("m2", "```json\n"),
      ocText("m2", `${JSON.stringify({ findings: [finding], suspicions: [] })}\n\`\`\``),
      ocStep("m2"),
      "",
    ].join("\n");
    const { env, recorded } = fakeTool("opencode", { stdout });
    const result = await agent(["opencode", "--workdir", workdir, "--method-file", method], env);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tool: "opencode",
      model: "opencode/deepseek-v4.1-flash-free",
      variant: "max",
      findings_count: 1,
      suspicions_count: 0,
      signed_by: "OpenCode/Deepseek-V4.1-Flash",
    });
    expect(written(workdir)).toEqual({ findings: [finding], suspicions: [] });

    const call = recorded();
    expect(call.argv).toEqual(["run", "--standalone", "--model", "opencode/deepseek-v4.1-flash-free#max", "--format", "json"]);
    expect(call.cwd).toBe(worktree);
    expect(call.input).toContain("THE REVIEW METHOD");
    expect(call.input.endsWith(SHELL_NOTE)).toBe(true);
    const permission = JSON.parse(call.config as string).permission;
    expect(permission).toMatchObject({ edit: "deny", webfetch: "deny", websearch: "deny" });
    expect(permission.external_directory).toEqual({ "*": "deny", [`${workdir}/*`]: "allow" });
    expect(permission.bash).toEqual(READ_ONLY_BASH);
  });

  it("passes --model and --variant through and labels with the model", async () => {
    const { workdir } = staged();
    const { env, recorded } = fakeTool("opencode", { stdout: ocText("m1", fenced({ findings: [] })) });
    const { code, stdout } = await agent(
      ["opencode", "--workdir", workdir, "--method-file", method, "--model", "anthropic/claude-opus-5", "--variant", "high"],
      env,
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ variant: "high", signed_by: "OpenCode/Opus-5" });
    expect(recorded().argv[3]).toBe("anthropic/claude-opus-5#high");
  });

  it("exits 5 when the model says it could not read the code", async () => {
    const { workdir } = staged();
    const { env } = fakeTool("opencode", { stdout: ocText("m1", fenced({ error: "git show was denied" })) });
    const { code, error } = await agent(["opencode", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(5);
    expect(error?.error).toBe("review_incomplete");
    expect(written(workdir).findings).toBeUndefined();
  });

  it.each([
    ["an error event", { stdout: ocError("Model unavailable: opencode/x") }, "opencode reported an error: Model unavailable: opencode/x"],
    [
      "an error event after text",
      { stdout: [ocText("m1", fenced({ findings: [] })), ocError("rate limited")].join("\n") },
      "opencode reported an error: rate limited",
    ],
    ["a bare line", { stdout: "Error: not logged in" }, "opencode printed a line that is not a JSON event: Error: not logged in"],
    ["no output", { stdout: "  " }, "opencode printed nothing"],
    ["no text", { stdout: ocStep("m1") }, "opencode returned no final message"],
    ["blank text", { stdout: ocText("m1", "  ") }, "opencode returned no final message"],
    ["a non-zero exit with an error event", { stdout: ocError("no route"), exit: 1 }, "opencode exited 1: no route"],
  ])("exits 1 with agent_error on %s", async (_, fake, message) => {
    const { workdir } = staged();
    const { env } = fakeTool("opencode", fake);
    const { code, error } = await agent(["opencode", "--workdir", workdir, "--method-file", method], env);

    expect(code).toBe(1);
    expect(error?.error).toBe("agent_error");
    expect(String(error?.message)).toContain(message);
    expect(written(workdir).findings).toBeUndefined();
  });
});

describe("agent arguments", () => {
  it("prints the prompt and runs nothing with --print-prompt", async () => {
    const { workdir } = staged();
    writeFileSync(join(workdir, "findings.json"), "[]");
    const { code, stdout } = await agent(["opencode", "--workdir", workdir, "--print-prompt"], { PATH: newDir("empty") });

    expect(code).toBe(0);
    // The default method is this skill's SKILL.md.
    expect(stdout).toContain("<review-method>\n---\nname: mizcode-reviewer\n");
    expect(stdout).toContain("Do not run `review.js`");
    expect(stdout).toContain("## Shell in this run");
    expect(existsSync(join(workdir, "findings.json"))).toBe(true);
  });

  it.each([
    [[], "Name exactly one tool"],
    [["claude", "--workdir", "/w"], 'Unknown tool "claude"'],
    [["cursor"], "Missing --workdir"],
    [["cursor", "--workdir", "/nonexistent/workdir"], "There is no state.json in /nonexistent/workdir"],
    [["cursor", "--workdir", "/w", "--variant", "max"], "--variant is for opencode only"],
    [["opencode", "--workdir", "/w", "--model", ""], "--model must be one word"],
    [["cursor", "--workdir", "/w", "--timeout", "0"], "--timeout must be a whole number of seconds"],
    [["cursor", "--workdir", "/w", "--timeout", "1.5"], "--timeout must be a whole number of seconds"],
    [["cursor", "--workdir", "/w", "--timeout", "9999999"], "--timeout must be a whole number of seconds"],
    [["cursor", "--workdir", "/w", "--bogus"], "Unknown option '--bogus'"],
  ])("rejects %j as bad_input", async (argv, message) => {
    const { code, error } = await agent(argv, { PATH: newDir("empty") });

    expect(code).toBe(2);
    expect(error?.error).toBe("bad_input");
    expect(String(error?.message)).toContain(message);
  });

  it("rejects a missing method file as bad_input", async () => {
    const { workdir } = staged();
    const { code, error } = await agent(["cursor", "--workdir", workdir, "--method-file", "/nonexistent/SKILL.md"], {});

    expect(code).toBe(2);
    expect(String(error?.message)).toContain("Could not read the review method /nonexistent/SKILL.md");
  });
});

describe("extractObject", () => {
  it("takes the last fenced block when the schema is restated first", () => {
    const reply = `Here is the shape:\n${fenced({ findings: [{ path: "example.ts" }] })}\nAnd the review:\n${fenced({ findings: [] })}\n`;
    expect(extractObject(reply)).toEqual({ findings: [] });
  });

  it("accepts an unfenced object and prose around a block", () => {
    expect(extractObject('{"findings": []}')).toEqual({ findings: [] });
    expect(extractObject(`I reviewed it.\n\n${fenced({ suspicions: [] })}\n\nDone.`)).toEqual({ suspicions: [] });
  });

  it.each(["I could not access the diff.", "```json\nnot json\n```", "[]", '{"verdict": "fine"}'])(
    "refuses %j",
    (reply) => {
      expect(() => extractObject(reply)).toThrow("holds no review object");
    },
  );
});

describe("normalise", () => {
  it("treats missing arrays as empty", () => {
    expect(normalise({})).toEqual({ findings: [], suspicions: [] });
  });

  it("leaves an absent side absent", () => {
    const rest: Record<string, unknown> = { ...finding };
    delete rest.side;
    expect(normalise({ findings: [{ ...rest }] }).findings).toEqual([rest]);
  });

  it("puts the error first, ahead of an empty findings array", () => {
    expect(() => normalise({ error: "ran out of context", findings: [] })).toThrow("could not complete the review");
  });
});

describe("labels", () => {
  it.each([
    ["auto", "Auto"],
    ["claude-opus-5", "Opus-5"],
    ["claude-sonnet-4-5", "Sonnet-4.5"],
    ["gemini-2.5-pro", "Gemini-2.5-Pro"],
    ["composer-1", "Composer-1"],
    ["grok-4.7", "Grok-4.7"],
    ["gpt-5.1-codex[effort=high]", "GPT-5.1-Codex"],
    ["claude-opus-4-6[thinking=true,context=200k,effort=max]", "Opus-4.6"],
    ["gpt-5.6-sol-xhigh", "GPT-5.6-Sol"],
    ["gpt-5.3-codex-xhigh-fast", "GPT-5.3-Codex"],
    ["cursor-grok-4.6-xhigh", "Grok-4.6"],
    ["claude-opus-5-thinking-max-fast", "Opus-5"],
    ["gemini-3.7-flash-high", "Gemini-3.7-Flash"],
    ["composer-2.5-fast", "Composer-2.5"],
    ["gpt-5.5-extra-high-fast", "GPT-5.5"],
    ["gemini-3.6-flash-minimal", "Gemini-3.6-Flash"],
    ["gpt-5.6-terra-none", "GPT-5.6-Terra"],
    ["x", "X"],
    ["  ", ""],
  ])("prettyModel(%j) is %j", (model, label) => {
    expect(prettyModel(model)).toBe(label);
  });

  it("drops the provider and the free tier from an OpenCode model", () => {
    expect(opencodeLabel("opencode/deepseek-v4.1-flash-free")).toBe("OpenCode/Deepseek-V4.1-Flash");
    expect(opencodeLabel("opencode/big-pickle")).toBe("OpenCode/Big-Pickle");
  });
});

describe("opencode permissions", () => {
  it("denies every other command instead of asking", () => {
    // "ask" would leave a run with no one at the keyboard waiting forever.
    expect(Object.entries(READ_ONLY_BASH)[0]).toEqual(["*", "deny"]);
    expect(Object.values(READ_ONLY_BASH)).not.toContain("ask");
  });

  it("puts each write denial after the allowances it narrows", () => {
    // The last matching rule wins.
    const keys = Object.keys(READ_ONLY_BASH);
    const lastAllow = Math.max(...keys.map((key, i) => (READ_ONLY_BASH[key] === "allow" ? i : -1)));
    for (const pattern of ["*>*", "*--output*", "gh api * -X*", "gh api * -f *", "gh api * --input*"]) {
      expect(READ_ONLY_BASH[pattern]).toBe("deny");
      expect(keys.indexOf(pattern)).toBeGreaterThan(lastAllow);
    }
  });

  it("allows the quoted gh api read the prompt prints", () => {
    expect(READ_ONLY_BASH['gh api "repos/*']).toBe("allow");
    expect(buildPrompt({ repo: "o/r", pr: 1, headSha: sha, worktree: null, repoRoot: null }, "/w", "M")).toContain(
      `gh api "repos/o/r/contents/<path>?ref=${sha}"`,
    );
  });

  it("tells the model to return an error for code it could not read", () => {
    expect(SHELL_NOTE).toContain('{"error":');
    expect(SHELL_NOTE).toContain("Never return an empty review");
  });

  it("reads the error event of a failed run", () => {
    expect(() => opencodeReply(ocError("Model unavailable"))).toThrow("Model unavailable");
  });
});

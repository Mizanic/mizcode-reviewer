// How review.js agent runs Cursor's agent: its argv, its reply, and the label
// post signs with. The agent runs read-only (--mode ask): it can read the
// repository and run git and rg, but cannot edit, commit or touch GitHub. It
// does not run at all in a workspace with project config that could change
// that.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AgentFailed } from "./config.js";
// Cursor picks the model. --model overrides it.
const DEFAULT_MODEL = "auto";
// Cursor's model ids end in how the model runs, not which model it is.
const EFFORT_SUFFIXES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "extra", "max", "fast", "thinking"]);
// A readable model name from a model id:
// claude-opus-4-6[thinking=true,context=200k] -> Opus-4.6,
// gpt-5.6-sol-xhigh -> GPT-5.6-Sol, cursor-grok-4.6-xhigh-fast -> Grok-4.6.
// The vendor prefix and the effort and speed suffixes are dropped. An id this
// cannot read passes through unchanged.
export function prettyModel(model) {
    const base = model.trim().replace(/\[.*\]$/, "");
    if (base === "")
        return model.trim();
    let tokens = base.split("-");
    if (tokens.length > 1 && ["claude", "cursor"].includes(tokens[0].toLowerCase()))
        tokens = tokens.slice(1);
    const words = [];
    let version = [];
    for (const token of [...tokens, ""]) {
        if (/^\d+(?:\.\d+)*$/.test(token)) {
            version.push(token);
            continue;
        }
        if (EFFORT_SUFFIXES.has(token.toLowerCase()) && (words.length > 0 || version.length > 0))
            continue;
        if (version.length > 0) {
            words.push(version.join("."));
            version = [];
        }
        if (token)
            words.push(token.toLowerCase() === "gpt" ? "GPT" : token.charAt(0).toUpperCase() + token.slice(1));
    }
    return words.length > 0 ? words.join("-") : base;
}
// The final message from --output-format json, which prints one envelope.
export function cursorReply(stdout) {
    const text = stdout.trim();
    if (text === "")
        throw new AgentFailed("cursor-agent printed nothing.");
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        // A sign-in or model-id failure prints a bare line instead of the
        // envelope. It is an error, never a review.
        throw new AgentFailed(`cursor-agent did not print a JSON envelope: ${text.slice(0, 500)}`);
    }
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        throw new AgentFailed("cursor-agent printed an envelope that is not a JSON object.");
    }
    const { is_error: isError, result } = envelope;
    if (isError)
        throw new AgentFailed(`cursor-agent reported an error: ${String(result).slice(0, 500)}`);
    if (typeof result !== "string" || result.trim() === "")
        throw new AgentFailed("cursor-agent returned an empty result.");
    return result;
}
// cursor-agent loads project config from the workspace, even in ask mode, and
// has no option that turns it off. In the head/ worktree that config comes
// from the pull request: hooks in .cursor/hooks.json or .claude/settings.json
// run programs, and a .cursor/cli.json can allow shell commands. Cursor keeps
// adding such files, so every entry in .cursor/ is refused except the two that
// cannot run anything: rules, which is prompt text, and mcp.json, whose
// servers wait for an approval this run never gives.
const SAFE_CURSOR_ENTRIES = new Set(["rules", "mcp.json"]);
export const UNSAFE_CLAUDE_PATHS = [".claude/settings.json", ".claude/settings.local.json", ".claude/plugins"];
export function unsafePaths(workspace) {
    let entries = [];
    try {
        entries = readdirSync(join(workspace, ".cursor"));
    }
    catch {
        // No .cursor directory.
    }
    return [
        ...entries.filter((entry) => !SAFE_CURSOR_ENTRIES.has(entry)).sort().map((entry) => `.cursor/${entry}`),
        ...UNSAFE_CLAUDE_PATHS.filter((path) => existsSync(join(workspace, path))),
    ];
}
export const cursor = {
    name: "cursor",
    executable: "cursor-agent",
    defaultModel: DEFAULT_MODEL,
    unsafePaths,
    promptNote: "",
    label: (model) => `Cursor/${prettyModel(model)}`,
    invocation(run) {
        const argv = [
            "--model",
            run.model,
            // Read-only: the agent can read and run a shell, but cannot edit the
            // branch it reviews.
            "--mode",
            "ask",
            // Without it, a run in a directory Cursor does not trust exits and asks
            // to be run interactively.
            "--trust",
            "--print",
            "--output-format",
            "json",
            "--workspace",
            run.workspace,
        ];
        // gather makes the workdir in the temp directory, so the agent needs it
        // added unless it is inside the workspace.
        if (!run.workdirInWorkspace)
            argv.push("--add-dir", run.workdir);
        return { argv, env: {} };
    },
    reply: cursorReply,
};

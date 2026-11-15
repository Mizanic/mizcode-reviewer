// How review.js agent runs OpenCode: its argv, its permission config, its
// reply, and the label post signs with.
//
// OpenCode has no read-only switch, so the run carries its own permission
// config. It allows only the read, grep, glob and list tools, held to paths in
// the workspace and workdir, and denies every other tool, never asks, so a run
// with no one at the keyboard cannot wait on an approval prompt.
//
// There is no shell. OpenCode checks each simple command of a shell line on
// its own, so pattern rules could not keep writes out: review found
// git difftool -x, gh api -if and --hostname, rg --hostname-bin and
// "git log | head > f" in turn. The execute tool runs JavaScript with network
// access whatever webfetch says. An allow-list also covers tools OpenCode adds
// later.
//
// The config stops writes, not reads: the read tool follows a symlink out of
// the workspace, so the run can read any file the user can, as a local review
// can.
import { AgentFailed } from "./config.js";
import { prettyModel } from "./cursor.js";
// DeepSeek V4.1 Flash on OpenCode Zen, free tier. --model overrides it.
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
// Reasoning effort, sent as the #variant suffix of --model. --variant
// overrides it.
export const DEFAULT_VARIANT = "max";
// The only tools the run has. The rest, the shell and execute among them,
// are denied by "*".
export const READ_TOOLS = ["read", "grep", "glob", "list"];
// Added to the prompt. A model that cannot read the code and reports nothing
// has written a false all-clear, so a read it cannot make must end in an error.
export const TOOLS_NOTE = `
## Tools in this run

You have only the read, grep, glob and list tools. There is no shell, no git
and no network, so the guidance above about \`git log\`, \`git blame\` and \`rg\`
does not apply: use grep for searches, and diff.patch for what changed.

If you cannot read code the review needs, return
\`{"error": "<what you could not read>"}\`. Never return an empty review for code
you did not read.
`;
export function permissionConfig(workdir) {
    return {
        permission: {
            "*": "deny",
            ...Object.fromEntries(READ_TOOLS.map((tool) => [tool, "allow"])),
            external_directory: { "*": "deny", [`${workdir}/*`]: "allow" },
        },
    };
}
// OpenCode/Deepseek-V4.1-Flash for the default. The provider prefix and the
// -free tier suffix say where the model ran, not which model it is.
export function opencodeLabel(model) {
    let name = model.trim();
    const slash = name.indexOf("/");
    if (slash !== -1)
        name = name.slice(slash + 1);
    if (name.endsWith("-free"))
        name = name.slice(0, -"-free".length);
    return `OpenCode/${prettyModel(name)}`;
}
// --format json prints one JSON event a line.
function events(stdout) {
    const out = [];
    for (const raw of stdout.split("\n")) {
        const line = raw.trim();
        if (line === "")
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            // As for Cursor: a bare line is a failure, never a review.
            throw new AgentFailed(`opencode printed a line that is not a JSON event: ${line.slice(0, 500)}`);
        }
        if (typeof event === "object" && event !== null && !Array.isArray(event))
            out.push(event);
    }
    return out;
}
function errorMessage(event) {
    const error = event.error;
    const message = typeof error === "object" && error !== null ? error.message : error;
    return String(message);
}
// The message of the first error event, to explain a non-zero exit.
export function opencodeError(stdout) {
    for (const line of stdout.split("\n")) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof event === "object" && event !== null && event.type === "error") {
            return errorMessage(event);
        }
    }
    return undefined;
}
// The text of the last assistant message. Earlier messages are narration
// between tool calls. Only the last one holds the review.
export function opencodeReply(stdout) {
    if (stdout.trim() === "")
        throw new AgentFailed("opencode printed nothing.");
    const stream = events(stdout);
    const failed = stream.find((event) => event.type === "error");
    if (failed)
        throw new AgentFailed(`opencode reported an error: ${errorMessage(failed).slice(0, 500)}`);
    const texts = new Map();
    let last;
    for (const event of stream) {
        const part = event.part;
        if (event.type !== "text" || typeof part !== "object" || part === null)
            continue;
        const { messageID: message, text } = part;
        texts.set(message, [...(texts.get(message) ?? []), String(text || "")]);
        last = message;
    }
    // A text event without a messageID belongs to no message.
    const result = last == null ? "" : (texts.get(last) ?? []).join("");
    if (result.trim() === "")
        throw new AgentFailed("opencode returned no final message.");
    return result;
}
export const opencode = {
    name: "opencode",
    executable: "opencode",
    defaultModel: DEFAULT_MODEL,
    defaultVariant: DEFAULT_VARIANT,
    needsWorktree: true,
    promptNote: TOOLS_NOTE,
    label: opencodeLabel,
    invocation(run) {
        return {
            // --standalone starts a private server, so this run's permission config
            // is the one in force, not whatever a background server loaded.
            argv: ["run", "--standalone", "--model", `${run.model}#${run.variant}`, "--format", "json"],
            env: {
                OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig(run.workdir)),
                // The workspace is the pull request's head. Without this, an
                // opencode.json the pull request adds is loaded and merged with the
                // config above, so the change under review could allow itself more.
                OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            },
        };
    },
    reply: opencodeReply,
    failure: opencodeError,
};

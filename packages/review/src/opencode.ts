// How review.js agent runs OpenCode: its argv, its permission config, its
// reply, and the label post signs with.
//
// OpenCode has no read-only switch that still allows a shell, so the run
// carries its own permission config: no edits, no web, no paths outside the
// workspace and workdir, and only the shell commands a review reads with.
// Every other command is denied, never asked, so a run with no one at the
// keyboard cannot wait on an approval prompt.

import type { AgentRun, Tool } from "./agent.js";
import { AgentFailed } from "./config.js";
import { prettyModel } from "./cursor.js";

// DeepSeek V4.1 Flash on OpenCode Zen, free tier. --model overrides it.
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
// Reasoning effort, sent as the #variant suffix of --model. --variant
// overrides it.
export const DEFAULT_VARIANT = "max";

// OpenCode checks the rules in order and the last match wins, so the denials
// after the allowances take the write forms back out of them. A rule's * is any
// text, and the rule must match the whole command. Each command is allowed as
// itself and followed by a space, never as a prefix: "git diff*" would also
// allow "git difftool -x <program>".
const READ_COMMANDS = [
  "git log",
  "git show",
  "git blame",
  "git diff",
  "git status",
  "git ls-files",
  "git rev-parse",
  "rg",
  "grep",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "base64 -d",
  "echo",
];

export const READ_ONLY_BASH: Record<string, "allow" | "deny"> = {
  "*": "deny",
  ...Object.fromEntries(READ_COMMANDS.flatMap((command) => [[command, "allow"], [`${command} *`, "allow"]])),
  "gh api repos/*": "allow",
  'gh api "repos/*': "allow",
  "gh api 'repos/*": "allow",
  // Redirection and --output write files. rg --pre and --hostname-bin run
  // a program.
  "*>*": "deny",
  "*--output*": "deny",
  "rg *--pre*": "deny",
  "rg *--hostname-bin*": "deny",
  // Each of these can make a gh api read a write, so each is denied, even
  // with GET.
  "gh api * -X*": "deny",
  "gh api * --method*": "deny",
  // -f and -F with the value attached too, as in -fbody=hi.
  "gh api * -f*": "deny",
  "gh api * -F*": "deny",
  "gh api * --field*": "deny",
  "gh api * --raw-field*": "deny",
  "gh api * --input*": "deny",
};

// Added to the prompt. A model that cannot read the code and reports nothing
// has written a false all-clear, so a denied read must end in an error.
export const SHELL_NOTE = `
## Shell in this run

The shell is restricted to read-only commands: \`git log\`, \`git show\`,
\`git blame\`, \`git diff\`, \`git status\`, \`git ls-files\`, \`git rev-parse\`, \`rg\`,
\`grep\`, \`ls\`, \`cat\`, \`head\`, \`tail\`, \`wc\`, \`echo\`, \`base64 -d\`, and
\`gh api repos/...\` reads. Pipes between them work. Anything else is denied, as are \`;\`, \`&&\`,
redirection, and any \`gh api\` write flag. Run one command per call.

If a denial leaves you unable to read code the review needs, retry with an
allowed form or with your read tool. If you still cannot read it, return
\`{"error": "<what you could not read>"}\`. Never return an empty review for code
you did not read.
`;

export function permissionConfig(workdir: string) {
  return {
    permission: {
      edit: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: { "*": "deny", [`${workdir}/*`]: "allow" },
      bash: READ_ONLY_BASH,
    },
  };
}

// OpenCode/Deepseek-V4.1-Flash for the default. The provider prefix and the
// -free tier suffix say where the model ran, not which model it is.
export function opencodeLabel(model: string): string {
  let name = model.trim();
  const slash = name.indexOf("/");
  if (slash !== -1) name = name.slice(slash + 1);
  if (name.endsWith("-free")) name = name.slice(0, -"-free".length);
  return `OpenCode/${prettyModel(name)}`;
}

// --format json prints one JSON event a line.
function events(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // As for Cursor: a bare line is a failure, never a review.
      throw new AgentFailed(`opencode printed a line that is not a JSON event: ${line.slice(0, 500)}`);
    }
    if (typeof event === "object" && event !== null && !Array.isArray(event)) out.push(event as Record<string, unknown>);
  }
  return out;
}

function errorMessage(event: Record<string, unknown>): string {
  const error = event.error;
  const message = typeof error === "object" && error !== null ? (error as Record<string, unknown>).message : error;
  return String(message);
}

// The message of the first error event, to explain a non-zero exit.
export function opencodeError(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "error") {
      return errorMessage(event as Record<string, unknown>);
    }
  }
  return undefined;
}

// The text of the last assistant message. Earlier messages are narration
// between tool calls. Only the last one holds the review.
export function opencodeReply(stdout: string): string {
  if (stdout.trim() === "") throw new AgentFailed("opencode printed nothing.");
  const stream = events(stdout);
  const failed = stream.find((event) => event.type === "error");
  if (failed) throw new AgentFailed(`opencode reported an error: ${errorMessage(failed).slice(0, 500)}`);
  const texts = new Map<unknown, string[]>();
  let last: unknown;
  for (const event of stream) {
    const part = event.part;
    if (event.type !== "text" || typeof part !== "object" || part === null) continue;
    const { messageID: message, text } = part as Record<string, unknown>;
    texts.set(message, [...(texts.get(message) ?? []), String(text || "")]);
    last = message;
  }
  // A text event without a messageID belongs to no message.
  const result = last == null ? "" : (texts.get(last) ?? []).join("");
  if (result.trim() === "") throw new AgentFailed("opencode returned no final message.");
  return result;
}

export const opencode: Tool = {
  name: "opencode",
  executable: "opencode",
  defaultModel: DEFAULT_MODEL,
  defaultVariant: DEFAULT_VARIANT,
  promptNote: SHELL_NOTE,
  label: opencodeLabel,
  invocation(run: AgentRun) {
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

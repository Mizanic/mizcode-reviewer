// review.js mcp: a local MCP server for OpenCode. OpenCode can't run a command
// to make the Authorization header the way Claude Code and Codex do, so it
// starts this relay instead and talks to it over stdin and stdout. The relay
// sends each JSON-RPC message to the shared bot's server with the token from
// token.json, refreshing it the same way review.js token does, and writes the
// server's answer back. It reads the token for every message, so a sign-in
// made after OpenCode started is used at once.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { BadInput } from "./config.js";
import type { RunOptions } from "./review.js";
import { authHeader } from "./signin.js";

// The same server the Claude Code and Codex plugins connect to.
export const SERVER_URL = "https://xu7ug7aw2h.execute-api.us-east-1.amazonaws.com/v1/mcp";

export const MCP_USAGE = `Usage: review.js mcp

Runs a local MCP server on stdin and stdout for OpenCode. It forwards each
JSON-RPC message to the shared mizcode-reviewer server with the token from
review.js login, and writes the server's answer to stdout. It ends when stdin
closes.

Options:
  -h, --help  Show this help
`;

type Id = string | number | null;

function idOf(message: unknown): Id | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  return (message as { id?: Id }).id;
}

function errorReply(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// Sends one line from OpenCode to the server. Returns the line to write
// back, or null when there is nothing to answer: a notification.
async function forward(line: string, options: RunOptions): Promise<string | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorReply(null, -32700, "Parse error");
  }
  const id = idOf(message);

  let response: Response;
  let text: string;
  try {
    response = await (options.fetch ?? fetch)(SERVER_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(await authHeader(options)),
      },
      body: line,
    });
    text = await response.text();
  } catch (error) {
    if (id === undefined) return null;
    const cause = (error as Error & { cause?: Error }).cause;
    return errorReply(
      id,
      -32603,
      `Could not reach the mizcode-reviewer server: ${cause?.message ?? (error as Error).message}. Check the network connection and try again.`,
    );
  }

  // The server answers 403 to a tool call without a usable token. Hand it
  // to the AI as the tool's error, the same JSON the server sends, so the
  // skill signs the user in and calls the tool again.
  if (response.status === 403 && id !== undefined) {
    return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
  }
  if (!response.ok) {
    if (id === undefined) return null;
    return errorReply(id, -32603, `The mizcode-reviewer server answered HTTP ${response.status}.`);
  }
  if (text.trim() === "") return null;
  try {
    // One message per line: the server's JSON may span lines.
    return JSON.stringify(JSON.parse(text));
  } catch {
    if (id === undefined) return null;
    return errorReply(id, -32603, "The mizcode-reviewer server sent an answer that is not JSON.");
  }
}

export async function mcp(argv: string[], options: RunOptions): Promise<string> {
  let help: boolean | undefined;
  try {
    help = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" } }, strict: true }).values.help;
  } catch (error) {
    throw new BadInput(`${(error as Error).message.replace(/\.+$/, "")}. Run review.js mcp --help for usage.`);
  }
  if (help) return MCP_USAGE;

  const input = options.input ?? createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  // Messages are answered as they finish, not in order: JSON-RPC matches
  // answers to requests by id.
  const pending = new Set<Promise<void>>();
  for await (const line of input) {
    if (line.trim() === "") continue;
    const task = forward(line, options).then((reply) => {
      if (reply !== null) write(`${reply}\n`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
  return "";
}

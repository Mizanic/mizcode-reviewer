// The plan B MCP server: one tool, submit_review, that posts a review as the
// App for a user who can write to the repo. handleMcpRequest takes a web standard Request and returns a Response, so
// the local server and the Lambda adapter share it. It runs stateless: each
// request gets its own MCP server and transport, and nothing is kept between
// requests.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GitHubClientError,
  checkUserToken,
  postReviewAsApp,
  type ClientOptions,
  type ReviewComment,
} from "./github.js";

export interface McpConfig {
  appId: string;
  privateKey: string;
  // The GitHub login of the user who sent the request, or null. A request
  // that calls a tool gets 401 before any MCP handling when this is null.
  authenticate(request: Request): Promise<string | null>;
  github?: ClientOptions;
  // One line per tool call: who called it, for which pull request, and the
  // outcome. Never the token.
  log?: (line: string) => void;
}

const side = z.enum(["LEFT", "RIGHT"]);

const comment = z
  .strictObject({
    path: z.string().regex(/\S/, "path must not be blank").describe("File path in the pull request"),
    line: z.int().positive().describe("Line the comment is on, or the last line of a range"),
    side: side.describe("RIGHT for the new version of the file, LEFT for the old"),
    start_line: z.int().positive().optional().describe("First line of a multi-line range"),
    start_side: side.optional().describe("Side of start_line. Needs start_line"),
    body: z.string().regex(/\S/, "comment body must not be blank").describe("Markdown comment"),
  })
  .refine((value) => value.start_side === undefined || value.start_line !== undefined, {
    message: "start_side needs start_line",
  });

const submitReviewInput = z.strictObject({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, "repo must be owner/name")
    .describe("The repository, as owner/name"),
  pull_number: z.int().positive().describe("The pull request number"),
  commit_sha: z
    .string()
    .regex(/^[0-9a-fA-F]{40}$/, "commit_sha must be a full 40-character commit SHA")
    .describe("The full commit SHA the review was written against"),
  body: z.string().regex(/\S/, "body must not be blank").describe("Markdown summary of the review"),
  comments: z.array(comment).describe("Inline comments. Use [] for none"),
});

type SubmitReviewInput = z.infer<typeof submitReviewInput>;

const DESCRIPTION = `Post a pull request review as mizcode-reviewer[bot]. The review is always a COMMENT: it never approves or requests changes.

Posts nothing if the pull request head is no longer commit_sha. If the bot already posted the same review at commit_sha, posts nothing and returns that review.

Success returns {"review_id", "html_url"}. An error returns {"error", "message"} with error one of not_installed, no_access, head_moved (with current_head) or github_error (with GitHub's status).`;

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof GitHubClientError) {
    if (error.code === "head_moved") {
      return result({ error: "head_moved", message: error.message, current_head: error.currentHead }, true);
    }
    if (error.code === "not_installed" || error.code === "no_access") {
      return result({ error: error.code, message: error.message }, true);
    }
    return result({ error: "github_error", message: error.message, status: error.status }, true);
  }
  // fetch throws without an HTTP status when GitHub cannot be reached.
  const cause = (error as Error & { cause?: Error }).cause;
  return result({
    error: "github_error",
    message: `Could not complete the request to GitHub: ${cause?.message ?? (error as Error).message}`,
  }, true);
}

// Copies the known fields only, so nothing else in the input reaches GitHub.
function toComment(input: SubmitReviewInput["comments"][number]): ReviewComment {
  const out: ReviewComment = { path: input.path, line: input.line, side: input.side, body: input.body };
  if (input.start_line !== undefined) out.start_line = input.start_line;
  if (input.start_side !== undefined) out.start_side = input.start_side;
  return out;
}

// login is the user the request came from, or null when the request calls no
// tool. The review posts only if that user can write to the repo.
export function createMcpServer(config: McpConfig, login: string | null): McpServer {
  const server = new McpServer({ name: "mizcode-reviewer", version: "0.0.0" });
  server.registerTool(
    "submit_review",
    { title: "Submit review", description: DESCRIPTION, inputSchema: submitReviewInput },
    async (input) => {
      if (login === null) return result({ error: "unauthorized", message: "Missing or invalid access token." }, true);
      const [owner, name] = input.repo.split("/") as [string, string];
      const where = `${input.repo}#${input.pull_number}`;
      try {
        const posted = await postReviewAsApp(
          {
            appId: config.appId,
            privateKey: config.privateKey,
            repo: { owner, name },
            pullNumber: input.pull_number,
            sha: input.commit_sha.toLowerCase(),
            review: { body: input.body, comments: input.comments.map(toComment) },
            forUser: login,
          },
          config.github,
        );
        config.log?.(`submit_review ${login} ${where} posted ${posted.html_url}`);
        return result({ ...posted });
      } catch (error) {
        const failed = errorResult(error);
        const code = (JSON.parse((failed.content[0] as { text: string }).text) as { error: string }).error;
        config.log?.(`submit_review ${login} ${where} ${code}`);
        return failed;
      }
    },
  );
  return server;
}

// authenticate for McpConfig: the request's bearer token must be a user access
// token that our App issued. GitHub confirms that and names the user.
export function githubUserAuth(
  clientId: string,
  clientSecret: string,
  options: ClientOptions = {},
): (request: Request) => Promise<string | null> {
  return async (request) => {
    const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
    if (!match) return null;
    return checkUserToken(clientId, clientSecret, match[1] as string, options);
  };
}

// True if the JSON-RPC message, or any message in a batch, calls a tool.
function callsTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) => typeof message === "object" && message !== null && (message as { method?: unknown }).method === "tools/call",
  );
}

// Connecting and listing the tool need no token, so an AI tool that starts
// before the user signs in still shows submit_review. Calling it needs one.
// The 401 makes Claude Code and Codex run their headers helper again and
// retry the call with the token the user just signed in for.
export async function handleMcpRequest(request: Request, config: McpConfig): Promise<Response> {
  let body: unknown;
  if (request.method === "POST") {
    try {
      body = JSON.parse(await request.text());
    } catch {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
        { status: 400 },
      );
    }
  }
  let login: string | null = null;
  if (callsTool(body)) {
    login = await config.authenticate(request);
    if (login === null) {
      return Response.json({ error: "unauthorized", message: "Missing or invalid access token." }, { status: 401 });
    }
  }
  const server = createMcpServer(config, login);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, request.method === "POST" ? { parsedBody: body } : undefined);
  } finally {
    await server.close();
  }
}

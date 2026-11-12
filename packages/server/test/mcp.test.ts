import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import type { ClientOptions } from "../src/github.js";
import { githubUserAuth, handleMcpRequest, type McpConfig } from "../src/mcp.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const TOKEN = "Bearer test-token";
const sha = "a".repeat(40);
const input = {
  repo: "acme/widgets",
  pull_number: 7,
  commit_sha: sha,
  body: "Summary",
  comments: [
    { path: "src/app.ts", line: 120, side: "RIGHT", start_line: 115, start_side: "RIGHT", body: "Multi-line" },
    { path: "src/util.ts", line: 4, side: "RIGHT", body: "Single line" },
  ],
};

// Answers each GitHub request with the next queued response and records it.
function mockGitHub(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const options: ClientOptions = {
    fetch: async (url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${String(url)}`);
      const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
      return new Response(text, { status: next.status });
    },
  };
  return { calls, options };
}

function config(github: ClientOptions = mockGitHub().options): McpConfig {
  return {
    appId: "5312457",
    privateKey,
    authenticate: async (request) => (request.headers.get("authorization") === TOKEN ? "ali" : null),
    github,
  };
}

// An MCP client whose HTTP requests go straight to handleMcpRequest.
async function connect(cfg: McpConfig, authorization = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
    requestInit: { headers: authorization ? { authorization } : {} },
    fetch: (url, init) => handleMcpRequest(new Request(url, init), cfg),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function submit(cfg: McpConfig, args: unknown) {
  const client = await connect(cfg);
  const response = await client.callTool({ name: "submit_review", arguments: args as Record<string, unknown> });
  await client.close();
  const content = response.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { isError: response.isError === true, text, json };
}

const installation = { status: 200, body: { id: 99 } };
const token = { status: 201, body: { token: "ghs_installation" } };
const canWrite = { status: 200, body: { permission: "write" } };
const pull = { status: 200, body: { head: { sha } } };
const app = { status: 200, body: { slug: "mizcode-reviewer" } };
const noReviews = { status: 200, body: [] };
const posted = {
  status: 200,
  body: { id: 123, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123" },
};

describe("submit_review MCP server", () => {
  it("lists the submit_review tool with its input schema", async () => {
    const client = await connect(config());
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toEqual(["submit_review"]);
    const schema = tools[0]?.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required?.sort()).toEqual(["body", "comments", "commit_sha", "pull_number", "repo"]);
    expect(schema.properties).not.toHaveProperty("event");
  });

  it("posts a COMMENT review as the App and returns its ID and URL", async () => {
    const github = mockGitHub([installation, token, canWrite, pull, app, noReviews, posted]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(false);
    expect(response.json).toEqual({
      review_id: 123,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-123",
    });
    const post = github.calls.at(-1);
    expect(post?.method).toBe("POST");
    expect(post?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/reviews");
    expect(post?.body).toEqual({ commit_id: sha, body: "Summary", event: "COMMENT", comments: input.comments });
  });

  it("posts the body exactly as given, without trimming it", async () => {
    const github = mockGitHub([installation, token, canWrite, pull, app, noReviews, posted]);

    await submit(config(github.options), { ...input, body: "  Summary\n" });

    expect((github.calls.at(-1)?.body as { body: string }).body).toBe("  Summary\n");
  });

  it("accepts an uppercase commit SHA and posts it in lowercase", async () => {
    const github = mockGitHub([installation, token, canWrite, pull, app, noReviews, posted]);

    const response = await submit(config(github.options), { ...input, commit_sha: "A".repeat(40) });

    expect(response.isError).toBe(false);
    expect((github.calls.at(-1)?.body as { commit_id: string }).commit_id).toBe(sha);
  });

  it("returns the App's earlier review at this commit instead of posting again", async () => {
    const earlier = {
      status: 200,
      body: [
        {
          id: 55,
          html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
          user: { login: "mizcode-reviewer[bot]" },
          commit_id: sha,
          body: "Summary",
          state: "COMMENTED",
        },
      ],
    };
    const comments = {
      status: 200,
      body: input.comments.map((c) => ({
        pull_request_review_id: 55,
        path: c.path,
        original_line: c.line,
        original_start_line: c.start_line ?? null,
        side: c.side,
        start_side: c.start_side ?? null,
        body: c.body,
      })),
    };
    const github = mockGitHub([installation, token, canWrite, pull, app, earlier, comments]);

    const response = await submit(config(github.options), input);

    expect(response.json).toEqual({
      review_id: 55,
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
    });
    expect(github.calls.some((call) => call.method === "POST" && call.url.endsWith("/reviews"))).toBe(false);
  });

  it.each([
    ["repo without an owner", { repo: "widgets" }, "repo must be owner/name"],
    ["a short SHA", { commit_sha: "abc123" }, "commit_sha must be a full 40-character commit SHA"],
    ["pull_number zero", { pull_number: 0 }, "pull_number"],
    ["a blank body", { body: "  " }, "body must not be blank"],
    ["an event field", { event: "APPROVE" }, "event"],
    ["a blank comment body", { comments: [{ path: "a", line: 1, side: "RIGHT", body: " \n" }] }, "comment body must not be blank"],
    ["a comment side that is not LEFT or RIGHT", { comments: [{ path: "a", line: 1, side: "UP", body: "x" }] }, "side"],
    ["start_side without start_line", { comments: [{ path: "a", line: 1, side: "RIGHT", start_side: "RIGHT", body: "x" }] }, "start_side needs start_line"],
  ])("rejects %s without calling GitHub", async (_name, change, message) => {
    const github = mockGitHub();

    const response = await submit(config(github.options), { ...input, ...change });

    expect(response.isError).toBe(true);
    expect(response.text).toContain("Input validation error");
    expect(response.text).toContain(message);
    expect(github.calls).toHaveLength(0);
  });

  it("returns not_installed when the App is not on the repository", async () => {
    const github = mockGitHub([{ status: 404, body: { message: "Not Found" } }]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(true);
    expect(response.json?.error).toBe("not_installed");
    expect(response.json?.message).toEqual(expect.any(String));
  });

  it("checks the user's permission on the repo with the App's token", async () => {
    const github = mockGitHub([installation, token, canWrite, pull, app, noReviews, posted]);

    await submit(config(github.options), input);

    expect(github.calls[2]?.url).toBe("https://api.github.com/repos/acme/widgets/collaborators/ali/permission");
  });

  it.each([
    ["read permission", { status: 200, body: { permission: "read" } }, "ali has read permission"],
    ["no permission", { status: 200, body: { permission: "none" } }, "ali has none permission"],
    ["a user GitHub does not know", { status: 404, body: { message: "Not Found" } }, "ali has none permission"],
  ])("returns no_access for %s and posts nothing", async (_name, permission, message) => {
    const github = mockGitHub([installation, token, permission]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(true);
    expect(response.json?.error).toBe("no_access");
    expect(String(response.json?.message)).toContain(message);
    expect(github.calls).toHaveLength(3);
  });

  it("allows a post for admin permission", async () => {
    const github = mockGitHub([installation, token, { status: 200, body: { permission: "admin" } }, pull, app, noReviews, posted]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(false);
  });

  it("returns head_moved with the current head and posts nothing", async () => {
    const current = "b".repeat(40);
    const github = mockGitHub([installation, token, canWrite, { status: 200, body: { head: { sha: current } } }]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(true);
    expect(response.json).toMatchObject({ error: "head_moved", current_head: current });
    expect(github.calls.some((call) => call.method === "POST" && call.url.endsWith("/reviews"))).toBe(false);
  });

  it("returns github_error with GitHub's status and message", async () => {
    const github = mockGitHub([
      installation,
      token,
      canWrite,
      pull,
      app,
      noReviews,
      { status: 422, body: { message: "Unprocessable Entity" } },
    ]);

    const response = await submit(config(github.options), input);

    expect(response.isError).toBe(true);
    expect(response.json).toMatchObject({ error: "github_error", status: 422 });
    expect(String(response.json?.message)).toContain("Unprocessable Entity");
  });

  it("returns github_error when GitHub cannot be reached", async () => {
    const github: ClientOptions = {
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
      },
    };

    const response = await submit(config(github), input);

    expect(response.isError).toBe(true);
    expect(response.json?.error).toBe("github_error");
    expect(String(response.json?.message)).toContain("ENOTFOUND");
  });

  function rpc(message: unknown, authorization?: string): Request {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (authorization) headers.authorization = authorization;
    return new Request("http://mcp.test/mcp", { method: "POST", headers, body: JSON.stringify(message) });
  }

  it("lists the tool without a token, so an AI tool started before sign-in still shows it", async () => {
    const github = mockGitHub();
    const client = await connect(config(github.options), "");
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((tool) => tool.name)).toEqual(["submit_review"]);
    expect(github.calls).toHaveLength(0);
  });

  it.each([
    ["no token", undefined],
    ["a wrong token", "Bearer wrong"],
  ])("returns 403 unauthorized, not 401, before any MCP handling for a tool call with %s", async (_name, authorization) => {
    const github = mockGitHub();
    const response = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_review", arguments: input } }, authorization),
      config(github.options),
    );

    expect(response.status).toBe(403);
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      message: "Missing or invalid access token. Run review.js login, then call again.",
    });
    expect(github.calls).toHaveLength(0);
  });

  it("returns 403 for a batch that hides a tool call among other messages", async () => {
    const response = await handleMcpRequest(
      rpc([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_review", arguments: input } },
      ]),
      config(),
    );

    expect(response.status).toBe(403);
  });

  it("answers a body that is not JSON with a JSON-RPC parse error", async () => {
    const response = await handleMcpRequest(
      new Request("http://mcp.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
      config(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  });

  it("logs the user, the pull request and the outcome of each call, and never the token", async () => {
    const lines: string[] = [];
    const posting = mockGitHub([installation, token, canWrite, pull, app, noReviews, posted]);
    await submit({ ...config(posting.options), log: (line) => lines.push(line) }, input);
    const refused = mockGitHub([installation, token, { status: 200, body: { permission: "read" } }]);
    await submit({ ...config(refused.options), log: (line) => lines.push(line) }, input);

    expect(lines).toEqual([
      "submit_review ali acme/widgets#7 posted https://github.com/acme/widgets/pull/7#pullrequestreview-123",
      "submit_review ali acme/widgets#7 no_access",
    ]);
    expect(lines.join("\n")).not.toContain("test-token");
  });
});

describe("githubUserAuth", () => {
  const request = (authorization?: string) =>
    new Request("http://mcp.test/mcp", { headers: authorization ? { authorization } : {} });
  const checked = (clientId: string, login: string) => ({
    status: 200,
    body: { app: { client_id: clientId }, user: { login } },
  });

  it("asks GitHub about the token with the App's client ID and secret and returns the login", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const auth = githubUserAuth("Iv1.client", "secret", {
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
        return Response.json(checked("Iv1.client", "ali").body);
      },
    });

    expect(await auth(request("Bearer ghu_user"))).toBe("ali");
    expect(calls[0]?.url).toBe("https://api.github.com/applications/Iv1.client/token");
    expect(calls[0]?.headers.Authorization).toBe(`Basic ${Buffer.from("Iv1.client:secret").toString("base64")}`);
    expect(calls[0]?.body).toEqual({ access_token: "ghu_user" });
  });

  it("returns null for a token GitHub does not know", async () => {
    const github = mockGitHub([{ status: 404, body: { message: "Not Found" } }]);
    expect(await githubUserAuth("Iv1.client", "secret", github.options)(request("Bearer ghu_bad"))).toBeNull();
  });

  it("returns null for a token another App issued", async () => {
    const github = mockGitHub([checked("Iv1.other", "ali")]);
    expect(await githubUserAuth("Iv1.client", "secret", github.options)(request("Bearer ghu_other"))).toBeNull();
  });

  it("returns null without calling GitHub when there is no bearer token", async () => {
    const github = mockGitHub();
    const auth = githubUserAuth("Iv1.client", "secret", github.options);
    expect(await auth(request())).toBeNull();
    expect(await auth(request("Basic abc"))).toBeNull();
    expect(github.calls).toHaveLength(0);
  });
});

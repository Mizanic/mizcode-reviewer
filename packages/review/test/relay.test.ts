import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_URL } from "../src/relay.js";
import { CLIENT_ID } from "../src/signin.js";
import { home, mockGitHub, run } from "./helpers.js";

const T0 = 1_800_000_000_000;
const HOUR = 3600 * 1000;

const initialize = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } };
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "check_repo", arguments: { repo: "acme/widgets" } },
};

function signIn(dir: string, token: Record<string, unknown>): void {
  const config = join(dir, ".config", "mizcode-reviewer");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "token.json"), JSON.stringify(token));
}

// Runs review.js mcp over the given lines and returns what it wrote, one
// parsed message per line.
async function relay(lines: string[], options: Parameters<typeof run>[1]) {
  let written = "";
  const result = await run(["mcp"], { ...options, input: lines, write: (text) => (written += text) });
  const replies = written === "" ? [] : written.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...result, written, replies };
}

describe("review.js mcp", () => {
  it("sends each message to the server with the token and writes the answer as one line", async () => {
    const dir = home({});
    signIn(dir, { access_token: "ghu_live", expires_at: T0 + HOUR });
    const answer = { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", serverInfo: { name: "mizcode-reviewer" } } };
    const server = mockGitHub([{ status: 200, body: JSON.stringify(answer, null, 2) }]);

    const { code, stdout, written, replies } = await relay([JSON.stringify(initialize)], {
      ...server.options,
      home: dir,
      now: () => T0,
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(written.split("\n")).toHaveLength(2);
    expect(replies).toEqual([answer]);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: "POST", url: SERVER_URL, body: initialize });
    expect(server.calls[0]?.headers).toMatchObject({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: "Bearer ghu_live",
    });
  });

  it("sends no Authorization header when the user has not signed in", async () => {
    const dir = home({});
    const server = mockGitHub([{ status: 200, body: { jsonrpc: "2.0", id: 1, result: { tools: [] } } }]);

    const { replies } = await relay([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })], {
      ...server.options,
      home: dir,
    });

    expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
    expect(server.calls[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("hands a 403 to the AI as the tool's error, with the server's JSON", async () => {
    const dir = home({});
    const refusal = { error: "unauthorized", message: "Missing or invalid access token. Run review.js login, then call again." };
    const server = mockGitHub([{ status: 403, body: refusal }]);

    const { replies } = await relay([JSON.stringify(call)], { ...server.options, home: dir });

    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(refusal) }], isError: true } },
    ]);
  });

  it("reads the token for every message, so a sign-in after start is used", async () => {
    const dir = home({});
    const server = mockGitHub([
      { status: 403, body: { error: "unauthorized", message: "Missing or invalid access token." } },
      { status: 200, body: { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"ok":true}' }] } } },
    ]);
    async function* lines() {
      yield JSON.stringify(call);
      // Wait for the first message's answer, then sign in.
      while (server.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      signIn(dir, { access_token: "ghu_new", expires_at: T0 + HOUR });
      yield JSON.stringify({ ...call, id: 3 });
    }

    let written = "";
    const { code } = await run(["mcp"], {
      ...server.options,
      home: dir,
      now: () => T0,
      input: lines(),
      write: (text) => (written += text),
    });

    expect(code).toBe(0);
    expect(server.calls[0]?.headers).not.toHaveProperty("Authorization");
    expect(server.calls[1]?.headers).toMatchObject({ Authorization: "Bearer ghu_new" });
    expect(written).toContain('{\\"ok\\":true}');
  });

  it("refreshes an expired token before it sends the message", async () => {
    const dir = home({});
    signIn(dir, {
      access_token: "ghu_old",
      expires_at: T0 - HOUR,
      refresh_token: "ghr_old",
      refresh_token_expires_at: T0 + 100 * HOUR,
    });
    const both = mockGitHub([
      { status: 200, body: { access_token: "ghu_fresh", expires_in: 28800, refresh_token: "ghr_fresh", refresh_token_expires_in: 15897600 } },
      { status: 200, body: { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"ok":true}' }] } } },
    ]);

    await relay([JSON.stringify(call)], { ...both.options, home: dir, now: () => T0 });

    expect(both.calls[0]).toMatchObject({
      url: "https://github.com/login/oauth/access_token",
      body: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "ghr_old" },
    });
    expect(both.calls[1]?.headers).toMatchObject({ Authorization: "Bearer ghu_fresh" });
  });

  it("writes nothing for a notification", async () => {
    const dir = home({});
    const server = mockGitHub([{ status: 202, body: "" }]);

    const { written } = await relay([JSON.stringify(initialized)], { ...server.options, home: dir });

    expect(server.calls).toHaveLength(1);
    expect(written).toBe("");
  });

  it("answers a request with a JSON-RPC error when the server can't be reached", async () => {
    const dir = home({});
    const options = {
      home: dir,
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
      },
    };

    const { code, replies } = await relay([JSON.stringify(call), JSON.stringify(initialized)], options);

    expect(code).toBe(0);
    expect(replies).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32603,
          message:
            "Could not reach the mizcode-reviewer server: getaddrinfo ENOTFOUND. Check the network connection and try again.",
        },
      },
    ]);
  });

  it("answers a request with a JSON-RPC error when the server fails", async () => {
    const dir = home({});
    const server = mockGitHub([
      { status: 502, body: { message: "Internal server error" } },
      { status: 200, body: "<html>not json</html>" },
    ]);

    const { replies } = await relay([JSON.stringify(call), JSON.stringify({ ...call, id: 4 })], {
      ...server.options,
      home: dir,
    });

    expect(replies).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "The mizcode-reviewer server answered HTTP 502." },
    });
    expect(replies).toContainEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32603, message: "The mizcode-reviewer server sent an answer that is not JSON." },
    });
  });

  it("answers a line that is not JSON with a parse error and skips blank lines", async () => {
    const dir = home({});
    const server = mockGitHub([]);

    const { replies } = await relay(["{not json", "", "   "], { ...server.options, home: dir });

    expect(server.calls).toHaveLength(0);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
  });

  it("prints its help, and rejects an unknown flag", async () => {
    const help = await run(["mcp", "--help"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: review.js mcp");

    const bad = await run(["mcp", "--url", "https://example.com"], {});
    expect(bad.code).toBe(2);
    expect(bad.error).toMatchObject({ error: "bad_input" });
  });
});

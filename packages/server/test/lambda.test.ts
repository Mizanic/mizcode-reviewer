import { generateKeyPairSync } from "node:crypto";
import type { GetParametersCommand } from "@aws-sdk/client-ssm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientOptions } from "../src/github.js";
import { createHandler, loadConfig, type LambdaEnv, type ProxyEvent } from "../src/lambda.js";
import type { McpConfig } from "../src/mcp.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const TOKEN = "Bearer test-token";
const ACCEPT = "application/json, text/event-stream";

// A REST API proxy event as API Gateway sends it for POST /mcp.
function event(message: unknown, headers: Record<string, string> = {}, extra: Partial<ProxyEvent> = {}): ProxyEvent {
  const all = { Host: "abc123.execute-api.us-east-1.amazonaws.com", Accept: ACCEPT, "Content-Type": "application/json", ...headers };
  return {
    resource: "/mcp",
    path: "/mcp",
    httpMethod: "POST",
    headers: all,
    multiValueHeaders: Object.fromEntries(Object.entries(all).map(([name, value]) => [name, [value]])),
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    requestContext: { domainName: "abc123.execute-api.us-east-1.amazonaws.com", stage: "prod", path: "/prod/mcp" },
    body: JSON.stringify(message),
    isBase64Encoded: false,
    ...extra,
  } as ProxyEvent;
}

function config(github?: ClientOptions): McpConfig {
  return {
    appId: "5312457",
    privateKey,
    authenticate: async (request) => (request.headers.get("authorization") === TOKEN ? "ali" : null),
    github,
  };
}

const handler = createHandler(async () => config());

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callTool = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "submit_review",
    arguments: { repo: "acme/widgets", pull_number: 7, commit_sha: "a".repeat(40), body: "Summary", comments: [] },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Lambda handler", () => {
  it("answers tools/list sent as a REST API proxy event with the MCP response", async () => {
    const result = await handler(event(listTools));

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(result.multiValueHeaders["content-type"]?.[0]).toContain("application/json");
    const body = JSON.parse(result.body) as { id: number; result: { tools: Array<{ name: string }> } };
    expect(body.id).toBe(1);
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["submit_review"]);
  });

  it("answers initialize", async () => {
    const result = await handler(
      event({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).result.serverInfo.name).toBe("mizcode-reviewer");
  });

  it("reads a base64 body", async () => {
    const plain = event(listTools);
    const result = await handler({ ...plain, body: Buffer.from(plain.body as string).toString("base64"), isBase64Encoded: true });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).result.tools).toHaveLength(1);
  });

  it("reads the single-value headers when the event has no multiValueHeaders", async () => {
    const result = await handler({ ...event(listTools), multiValueHeaders: null });

    expect(result.statusCode).toBe(200);
  });

  it("returns 403 unauthorized for a tool call without a token", async () => {
    const result = await handler(event(callTool));

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).error).toBe("unauthorized");
  });

  it("passes the bearer token through, so a signed-in tool call reaches GitHub", async () => {
    const calls: string[] = [];
    const github: ClientOptions = {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      },
    };
    const signedIn = createHandler(async () => config(github));

    const result = await signedIn(event(callTool, { Authorization: TOKEN }));

    expect(result.statusCode).toBe(200);
    const text = JSON.parse(result.body).result.content[0].text as string;
    expect(JSON.parse(text).error).toBe("not_installed");
    expect(calls[0]).toContain("/repos/acme/widgets/installation");
  });

  it("answers GET with 405", async () => {
    const result = await handler({ ...event(null), httpMethod: "GET", body: null });

    expect(result.statusCode).toBe(405);
    expect(result.multiValueHeaders.allow).toEqual(["POST"]);
  });

  it("loads the config once and keeps it for later requests", async () => {
    const load = vi.fn(async () => config());
    const cached = createHandler(load);

    await cached(event(listTools));
    await cached(event(listTools));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("returns 500 without details when the config fails to load, and tries again on the next request", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<McpConfig>>()
      .mockRejectedValueOnce(new Error("Parameter Store has no value for /mizcode-reviewer/client-secret."))
      .mockResolvedValueOnce(config());
    const retrying = createHandler(load);

    const failed = await retrying(event(listTools));
    const next = await retrying(event(listTools));

    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("Parameter Store");
    expect(errors).toHaveBeenCalledWith(
      "Request failed: Parameter Store has no value for /mizcode-reviewer/client-secret.",
    );
    expect(next.statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("loadConfig", () => {
  const env: LambdaEnv = {
    MIZCODE_APP_ID: "5312457",
    MIZCODE_CLIENT_ID: "Iv23libdXUQOTm5d8vFp",
    MIZCODE_APP_KEY_PARAMETER: "/mizcode-reviewer/app-private-key",
    MIZCODE_CLIENT_SECRET_PARAMETER: "/mizcode-reviewer/client-secret",
  };

  function ssm(parameters: Record<string, string>) {
    const commands: GetParametersCommand[] = [];
    return {
      commands,
      send: async (command: GetParametersCommand) => {
        commands.push(command);
        const names = command.input.Names ?? [];
        return {
          Parameters: names.filter((name) => name in parameters).map((name) => ({ Name: name, Value: parameters[name] })),
          InvalidParameters: names.filter((name) => !(name in parameters)),
        };
      },
    };
  }

  const both = { "/mizcode-reviewer/app-private-key": privateKey, "/mizcode-reviewer/client-secret": "s3cret-value" };

  it("reads both parameters in one decrypted call and builds the config", async () => {
    const reader = ssm(both);

    const loaded = await loadConfig(env, reader);

    expect(reader.commands).toHaveLength(1);
    expect(reader.commands[0]?.input).toEqual({
      Names: ["/mizcode-reviewer/app-private-key", "/mizcode-reviewer/client-secret"],
      WithDecryption: true,
    });
    expect(loaded.appId).toBe("5312457");
    expect(loaded.privateKey).toBe(privateKey);
  });

  it("checks tokens with the App's client ID and the client secret from Parameter Store", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify({ app: { client_id: env.MIZCODE_CLIENT_ID }, user: { login: "ali" } }), {
        status: 200,
      });
    });
    const loaded = await loadConfig(env, ssm(both));

    const login = await loaded.authenticate(new Request("https://x/mcp", { headers: { authorization: "Bearer ghu_user" } }));

    expect(login).toBe("ali");
    expect(requests[0]?.url).toBe("https://api.github.com/applications/Iv23libdXUQOTm5d8vFp/token");
    expect(requests[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${env.MIZCODE_CLIENT_ID}:s3cret-value`).toString("base64")}`,
    );
  });

  it("logs tool calls with console.log", async () => {
    const lines = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const loaded = await loadConfig(env, ssm(both));

    loaded.log?.("submit_review ali acme/widgets#7 no_access");

    expect(lines).toHaveBeenCalledWith("submit_review ali acme/widgets#7 no_access");
  });

  it("names a missing parameter and never shows a value", async () => {
    const error = await loadConfig(env, ssm({ "/mizcode-reviewer/app-private-key": privateKey })).catch((e: Error) => e);

    expect((error as Error).message).toBe("Parameter Store has no value for /mizcode-reviewer/client-secret.");
    expect((error as Error).message).not.toContain("PRIVATE KEY");
  });

  it("names a missing environment variable without calling Parameter Store", async () => {
    const reader = ssm(both);

    await expect(loadConfig({ ...env, MIZCODE_CLIENT_ID: undefined }, reader)).rejects.toThrow(
      "The environment variable MIZCODE_CLIENT_ID is not set.",
    );
    expect(reader.commands).toHaveLength(0);
  });

  it("refuses a key that is not an RSA private key, without showing it", async () => {
    const error = await loadConfig(env, ssm({ ...both, "/mizcode-reviewer/app-private-key": "not-a-key" })).catch(
      (e: Error) => e,
    );

    expect((error as Error).message).toBe(
      "/mizcode-reviewer/app-private-key is not an RSA private key. Use the App's .pem file.",
    );
  });
});

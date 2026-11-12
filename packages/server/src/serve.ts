#!/usr/bin/env node
// Runs the MCP server on this machine, on 127.0.0.1 only, for testing. It
// accepts a request only if its bearer token is a user access token our App
// issued, which GitHub confirms with the App's client ID and secret.

import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { parseArgs } from "node:util";
import { githubUserAuth, handleMcpRequest } from "./mcp.js";

const USAGE = `Usage: MIZCODE_CLIENT_SECRET=<secret> node serve.js --app-id <id> --client-id <id> --key-file <path> [--port <port>]

Runs the submit_review MCP server at http://127.0.0.1:<port>/mcp, default port 8787.
MIZCODE_CLIENT_SECRET is the App's client secret, from the App's settings page.
`;

const { values } = parseArgs({
  options: {
    "app-id": { type: "string" },
    "client-id": { type: "string" },
    "key-file": { type: "string" },
    port: { type: "string", default: "8787" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

const clientSecret = process.env.MIZCODE_CLIENT_SECRET;
if (values.help || !values["app-id"] || !values["client-id"] || !values["key-file"] || !clientSecret) {
  process.stderr.write(USAGE);
  process.exit(values.help ? 0 : 2);
}

const appId = values["app-id"];
const privateKey = readFileSync(values["key-file"], "utf8");
if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa") {
  process.stderr.write(`${values["key-file"]} is not an RSA private key. Use the App's .pem file.\n`);
  process.exit(2);
}
const port = Number(values.port);

const authenticate = githubUserAuth(values["client-id"], clientSecret);

async function toRequest(message: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : [value ?? ""]) headers.append(name, item);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const method = message.method ?? "GET";
  return new Request(`http://127.0.0.1:${port}${message.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

const server = createServer((message, reply) => {
  void (async () => {
    try {
      const request = await toRequest(message);
      const response =
        new URL(request.url).pathname === "/mcp"
          ? await handleMcpRequest(request, { appId, privateKey, authenticate })
          : new Response("Not found\n", { status: 404 });
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      process.stderr.write(`Request failed: ${(error as Error).message}\n`);
      reply.writeHead(500).end();
    }
  })();
});

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`MCP server at http://127.0.0.1:${port}/mcp\n`);
});

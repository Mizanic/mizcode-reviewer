// The plan B MCP server as a Lambda Event Function behind an API Gateway REST
// API with Lambda proxy integration. The handler turns the proxy event into a
// web standard Request, passes it to handleMcpRequest, the same code the local
// server runs, and turns the Response back into a proxy result.
//
// The App private key and the App's client secret are SecureString parameters
// in SSM Parameter Store. The handler reads them once per execution
// environment, on its first request, and never logs them. The App ID and the
// client ID are public and come from environment variables.

import { createPrivateKey } from "node:crypto";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { githubUserAuth, handleMcpRequest, type McpConfig } from "./mcp.js";

// The fields of API Gateway's REST API proxy event that the handler reads.
export interface ProxyEvent {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { domainName?: string };
}

export interface ProxyResult {
  statusCode: number;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

// The environment variables the CDK stack sets on the function.
export interface LambdaEnv {
  MIZCODE_APP_ID?: string;
  MIZCODE_CLIENT_ID?: string;
  MIZCODE_APP_KEY_PARAMETER?: string;
  MIZCODE_CLIENT_SECRET_PARAMETER?: string;
}

// The part of SSMClient that loadConfig uses, so a test can pass a fake.
export interface ParameterReader {
  send(command: GetParametersCommand): Promise<{
    Parameters?: Array<{ Name?: string; Value?: string }>;
    InvalidParameters?: string[];
  }>;
}

function required(env: LambdaEnv, name: keyof LambdaEnv): string {
  const value = env[name];
  if (!value) throw new Error(`The environment variable ${name} is not set.`);
  return value;
}

// Builds the server config from the environment and the two parameters. An
// error names the variable or parameter that is wrong, never a value.
export async function loadConfig(env: LambdaEnv, ssm: ParameterReader): Promise<McpConfig> {
  const appId = required(env, "MIZCODE_APP_ID");
  const clientId = required(env, "MIZCODE_CLIENT_ID");
  const keyName = required(env, "MIZCODE_APP_KEY_PARAMETER");
  const secretName = required(env, "MIZCODE_CLIENT_SECRET_PARAMETER");

  const result = await ssm.send(new GetParametersCommand({ Names: [keyName, secretName], WithDecryption: true }));
  const values = new Map((result.Parameters ?? []).map((parameter) => [parameter.Name, parameter.Value]));
  const missing = [keyName, secretName].filter((name) => !values.get(name));
  if (missing.length > 0) throw new Error(`Parameter Store has no value for ${missing.join(" and ")}.`);

  const privateKey = values.get(keyName) as string;
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey(privateKey).asymmetricKeyType;
  } catch {
    keyType = undefined;
  }
  if (keyType !== "rsa") throw new Error(`${keyName} is not an RSA private key. Use the App's .pem file.`);

  return {
    appId,
    privateKey,
    authenticate: githubUserAuth(clientId, values.get(secretName) as string),
    log: (line) => console.log(line),
  };
}

function toRequest(event: ProxyEvent): Request {
  const headers = new Headers();
  if (event.multiValueHeaders) {
    for (const [name, values] of Object.entries(event.multiValueHeaders)) {
      for (const value of values ?? []) headers.append(name, value);
    }
  } else {
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (value !== undefined) headers.set(name, value);
    }
  }

  const query = new URLSearchParams();
  for (const [name, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) {
    for (const value of values ?? []) query.append(name, value);
  }
  const host = headers.get("host") ?? event.requestContext?.domainName ?? "localhost";
  const search = query.size > 0 ? `?${query.toString()}` : "";

  const method = event.httpMethod.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && event.body != null;
  return new Request(`https://${host}${event.path}${search}`, {
    method,
    headers,
    body: hasBody ? Buffer.from(event.body as string, event.isBase64Encoded ? "base64" : "utf8") : undefined,
  });
}

async function toResult(response: Response): Promise<ProxyResult> {
  const multiValueHeaders: Record<string, string[]> = {};
  response.headers.forEach((value, name) => {
    (multiValueHeaders[name] ??= []).push(value);
  });
  return { statusCode: response.status, multiValueHeaders, body: await response.text(), isBase64Encoded: false };
}

// Returns a handler that loads its config on the first request and keeps it
// for the life of the execution environment. A failed load is not kept, so
// the next request tries again.
export function createHandler(load: () => Promise<McpConfig>): (event: ProxyEvent) => Promise<ProxyResult> {
  let config: Promise<McpConfig> | undefined;
  return async (event) => {
    try {
      config ??= load();
      const ready = await config.catch((error: unknown) => {
        config = undefined;
        throw error;
      });
      return await toResult(await handleMcpRequest(toRequest(event), ready));
    } catch (error) {
      console.error(`Request failed: ${(error as Error).message}`);
      return {
        statusCode: 500,
        multiValueHeaders: { "content-type": ["application/json"] },
        body: JSON.stringify({ error: "server_error", message: "The server failed. Try again later." }),
        isBase64Encoded: false,
      };
    }
  };
}

export const handler = createHandler(() => loadConfig(process.env, new SSMClient({})));

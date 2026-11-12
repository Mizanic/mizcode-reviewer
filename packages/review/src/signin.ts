// Sign-in for the shared bot. review.js login runs GitHub's device flow for
// the mizcode-reviewer App and saves the user access token in
// ~/.config/mizcode-reviewer/token.json. review.js token prints the
// Authorization header for the MCP server, refreshing the token first if it
// has expired. The token stays on this machine. The server only asks GitHub
// whether the token is the App's and whose it is.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BadInput, configDir } from "./config.js";
import type { RunOptions } from "./review.js";

// The mizcode-reviewer App's client ID. It is public: GitHub shows it on the
// sign-in page.
export const CLIENT_ID = "Iv23libdXUQOTm5d8vFp";

const GITHUB_URL = "https://github.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Refresh this long before the token expires, so a call never starts with a
// token that runs out on the way.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class SignInFailed extends Error {}

export const LOGIN_USAGE = `Usage: review.js login

Signs in to GitHub for the shared mizcode-reviewer bot. Prints a code and a
URL. Open the URL on any device and enter the code. The token is saved in
~/.config/mizcode-reviewer/token.json, on this machine only.

Options:
  -h, --help  Show this help
`;

export const TOKEN_USAGE = `Usage: review.js token

Prints {"Authorization": "Bearer <token>"} for the mizcode-reviewer MCP
server, refreshing the saved token first if it has expired. Prints {} if
there is no usable token: run review.js login.

Options:
  -h, --help  Show this help
`;

interface SavedToken {
  access_token: string;
  // Milliseconds since the epoch. Absent if the token does not expire.
  expires_at?: number;
  refresh_token?: string;
  refresh_token_expires_at?: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  interval?: number;
}

function tokenPath(options: RunOptions): string {
  return join(configDir(options.home ?? homedir()), "token.json");
}

function now(options: RunOptions): number {
  return options.now?.() ?? Date.now();
}

async function postForm(options: RunOptions, path: string, body: Record<string, string>): Promise<TokenResponse> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(`${GITHUB_URL}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "mizcode-reviewer" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new SignInFailed(`GitHub returned ${response.status} for ${path}.`);
  return (await response.json()) as TokenResponse;
}

function toSaved(response: TokenResponse, at: number): SavedToken {
  const saved: SavedToken = { access_token: response.access_token as string };
  if (response.expires_in !== undefined) saved.expires_at = at + response.expires_in * 1000;
  if (response.refresh_token !== undefined) saved.refresh_token = response.refresh_token;
  if (response.refresh_token_expires_in !== undefined) {
    saved.refresh_token_expires_at = at + response.refresh_token_expires_in * 1000;
  }
  return saved;
}

async function save(options: RunOptions, token: SavedToken): Promise<void> {
  const path = tokenPath(options);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function load(options: RunOptions): Promise<SavedToken | null> {
  try {
    const data = JSON.parse(await readFile(tokenPath(options), "utf8")) as Partial<SavedToken>;
    return typeof data.access_token === "string" ? (data as SavedToken) : null;
  } catch {
    return null;
  }
}

function sleep(options: RunOptions, ms: number): Promise<void> {
  return options.sleep ? options.sleep(ms) : new Promise((done) => setTimeout(done, ms));
}

function parseNoArgs(argv: string[], command: string): boolean {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    });
    return parsed.values.help === true;
  } catch (error) {
    throw new BadInput(`${(error as Error).message.replace(/\.+$/, "")}. Run review.js ${command} --help for usage.`);
  }
}

export async function login(argv: string[], options: RunOptions): Promise<string> {
  if (parseNoArgs(argv, "login")) return LOGIN_USAGE;

  const device = (await postForm(options, "/login/device/code", { client_id: CLIENT_ID })) as TokenResponse & {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
  };
  if (device.error || !device.device_code || !device.user_code) {
    throw new SignInFailed(`GitHub refused to start the sign-in: ${device.error_description ?? device.error}.`);
  }
  options.progress?.(
    `Open ${device.verification_uri ?? `${GITHUB_URL}/login/device`} on any device and enter the code ${device.user_code}\n`,
  );

  let interval = (device.interval ?? 5) * 1000;
  const deadline = now(options) + (device.expires_in ?? 900) * 1000;
  while (now(options) < deadline) {
    await sleep(options, interval);
    const response = await postForm(options, "/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: device.device_code,
      grant_type: DEVICE_GRANT,
    });
    if (response.access_token) {
      await save(options, toSaved(response, now(options)));
      return `${JSON.stringify({ signed_in: true, token_file: tokenPath(options) })}\n`;
    }
    if (response.error === "authorization_pending") continue;
    if (response.error === "slow_down") {
      interval = (response.interval ?? interval / 1000 + 5) * 1000;
      continue;
    }
    if (response.error === "access_denied") throw new SignInFailed("The sign-in was cancelled on GitHub.");
    if (response.error === "expired_token") break;
    throw new SignInFailed(`GitHub refused the sign-in: ${response.error_description ?? response.error}.`);
  }
  throw new SignInFailed("The code expired before it was entered. Run review.js login again.");
}

// Returns a usable access token, refreshing it if it has expired, or null.
async function currentToken(options: RunOptions): Promise<string | null> {
  const saved = await load(options);
  if (!saved) return null;
  const at = now(options);
  if (saved.expires_at === undefined || saved.expires_at - REFRESH_MARGIN_MS > at) return saved.access_token;
  if (!saved.refresh_token || (saved.refresh_token_expires_at ?? Infinity) <= at) return null;

  // A device flow token refreshes without the client secret.
  const response = await postForm(options, "/login/oauth/access_token", {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
  });
  if (!response.access_token) return null;
  await save(options, toSaved(response, at));
  return response.access_token;
}

// The MCP client runs this before it connects. It must never fail: with no
// usable token it prints {} and the server answers 401.
export async function token(argv: string[], options: RunOptions): Promise<string> {
  if (parseNoArgs(argv, "token")) return TOKEN_USAGE;
  let value: string | null;
  try {
    value = await currentToken(options);
  } catch {
    value = null;
  }
  return `${JSON.stringify(value ? { Authorization: `Bearer ${value}` } : {})}\n`;
}

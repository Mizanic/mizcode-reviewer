import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { runReview, type RunOptions } from "../src/review.js";

export const root = mkdtempSync(join(tmpdir(), "mizcode-review-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
export function newDir(name: string): string {
  const dir = join(root, `${name}-${++count}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// A home directory whose .config/mizcode-reviewer holds the given files.
export function home(files: Record<string, string> = { "config.json": '{"app_id": 5312457}', "app.pem": rsaKey }): string {
  const dir = newDir("home");
  const config = join(dir, ".config", "mizcode-reviewer");
  mkdirSync(config, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(config, name), content);
  return dir;
}

export function sh(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

// Answers each request with the next queued response and records the request.
export function mockGitHub(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Call[] = [];
  const options: RunOptions = {
    fetch: async (url, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        headers: init?.headers as Record<string, string>,
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

export async function run(argv: string[], options: RunOptions) {
  let stdout = "";
  let stderr = "";
  const code = await runReview(
    argv,
    { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
    options,
  );
  return { code, stdout, stderr, error: stderr ? (JSON.parse(stderr) as Record<string, unknown>) : undefined };
}

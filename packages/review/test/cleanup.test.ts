import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mockGitHub, newDir, run, sh } from "./helpers.js";

// A repo with one commit and a detached worktree of it inside a workdir, as
// gather leaves them.
function staged() {
  const repo = newDir("repo");
  sh(["init", "--quiet"], repo);
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  sh(["add", "app.ts"], repo);
  sh(["commit", "--quiet", "-m", "head"], repo);
  const workdir = newDir("workdir");
  const worktree = join(workdir, "head");
  sh(["worktree", "add", "--quiet", "--detach", worktree, "HEAD"], repo);
  const repoRoot = sh(["rev-parse", "--show-toplevel"], repo);
  writeFileSync(join(workdir, "state.json"), JSON.stringify({ repo: "acme/widgets", pr: 7, worktree, repo_root: repoRoot }));
  return { repo, workdir, worktree };
}

function cleanup(argv: string[], cwd = newDir("cwd")) {
  return run(["cleanup", ...argv], { ...mockGitHub().options, cwd });
}

describe("cleanup", () => {
  it("removes the worktree and keeps the workdir", async () => {
    const { repo, workdir, worktree } = staged();
    const { code, stdout, stderr } = await cleanup(["--workdir", workdir]);

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ worktree, result: "removed" });
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(join(workdir, "state.json"))).toBe(true);
    expect(sh(["worktree", "list"], repo)).not.toContain(worktree);
  });

  it("prunes the entry when the worktree is already gone", async () => {
    const { repo, workdir, worktree } = staged();
    rmSync(worktree, { recursive: true, force: true });
    const { code, stdout } = await cleanup(["--workdir", workdir]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ worktree, result: "already_gone" });
    expect(sh(["worktree", "list"], repo)).not.toContain(worktree);
  });

  it("reports none when gather made no worktree", async () => {
    const workdir = newDir("workdir");
    writeFileSync(join(workdir, "state.json"), JSON.stringify({ worktree: null, repo_root: null }));
    const { code, stdout } = await cleanup(["--workdir", workdir]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ worktree: null, result: "none" });
  });

  it("exits 1 with git_error when git refuses to remove the worktree", async () => {
    const { workdir, worktree } = staged();
    writeFileSync(join(worktree, "app.ts"), "changed\n");
    const { code, error } = await cleanup(["--workdir", workdir]);

    expect(code).toBe(1);
    expect(error?.error).toBe("git_error");
    expect(String(error?.message)).toContain(`git worktree remove ${worktree} failed`);
    expect(existsSync(worktree)).toBe(true);
  });

  it.each([
    [[], "Missing --workdir"],
    [["--workdir"], "Option '--workdir <value>' argument missing"],
    [["--workdir", "/nonexistent/workdir"], "There is no state.json in /nonexistent/workdir"],
    [["extra"], "Unexpected argument 'extra'"],
  ])("rejects %j as bad_input", async (argv, message) => {
    const { code, error } = await cleanup(argv);

    expect(code).toBe(2);
    expect(error?.error).toBe("bad_input");
    expect(String(error?.message)).toContain(message);
  });

  it("rejects a state.json without worktree and repo_root", async () => {
    const workdir = newDir("workdir");
    writeFileSync(join(workdir, "state.json"), JSON.stringify({ worktree: 3 }));
    const { code, error } = await cleanup(["--workdir", workdir]);

    expect(code).toBe(2);
    expect(String(error?.message)).toContain("must have worktree and repo_root");
  });
});

describe("mizcode-review", () => {
  it("prints usage for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const { code, stdout } = await run([flag], {});
      expect(code).toBe(0);
      expect(stdout).toContain("Usage: mizcode-review <command>");
    }
    for (const command of ["gather", "cleanup"]) {
      const { code, stdout } = await run([command, "--help"], {});
      expect(code).toBe(0);
      expect(stdout).toContain(`Usage: mizcode-review ${command}`);
    }
  });

  it("rejects no command and an unknown command as bad_input", async () => {
    const none = await run([], {});
    expect(none.code).toBe(2);
    expect(none.error?.error).toBe("bad_input");

    const unknown = await run(["post"], {});
    expect(unknown.code).toBe(2);
    expect(unknown.error).toEqual({
      error: "bad_input",
      message: 'Unknown command "post". Run mizcode-review --help for usage.',
    });
  });
});

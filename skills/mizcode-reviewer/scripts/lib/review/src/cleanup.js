// review.js cleanup: remove the worktree gather made. The workdir and
// its files stay.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BadInput } from "./config.js";
import { git } from "./git.js";
const OPTIONS = {
    workdir: { type: "string" },
    help: { type: "boolean", short: "h" },
};
export const CLEANUP_USAGE = `Usage: review.js cleanup --workdir <dir>

Removes the worktree that gather made in <dir>. The workdir and its files stay.

Options:
  --workdir <dir>  The workdir gather printed
  -h, --help       Show this help
`;
export class GitFailed extends Error {
}
function withoutPeriod(text) {
    return text.replace(/\.+$/, "");
}
async function readState(workdir) {
    const path = join(workdir, "state.json");
    let state;
    try {
        state = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new BadInput(`There is no state.json in ${workdir}. Pass the workdir that gather printed.`);
        }
        throw new BadInput(`Could not read ${path}: ${withoutPeriod(error.message)}.`);
    }
    const { worktree, repo_root: repoRoot } = (state ?? {});
    if ((worktree !== null && typeof worktree !== "string") || (repoRoot !== null && typeof repoRoot !== "string")) {
        throw new BadInput(`${path} must have worktree and repo_root, each a path or null.`);
    }
    return { worktree, repoRoot };
}
// Returns the text to print: the usage, or the result as JSON.
export async function cleanup(argv, options) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
    }
    catch (error) {
        throw new BadInput(`${withoutPeriod(error.message)}. Run review.js cleanup --help for usage.`);
    }
    if (parsed.values.help)
        return CLEANUP_USAGE;
    if (!parsed.values.workdir) {
        throw new BadInput("Missing --workdir. Run review.js cleanup --help for usage.");
    }
    const { worktree, repoRoot } = await readState(parsed.values.workdir);
    if (!worktree)
        return `${JSON.stringify({ worktree: null, result: "none" })}\n`;
    const cwd = repoRoot ?? options.cwd ?? process.cwd();
    // Checked first because some git versions refuse to remove a worktree whose
    // directory is gone, and others remove its entry without a word.
    if (!existsSync(worktree)) {
        await git(["worktree", "prune"], cwd);
        return `${JSON.stringify({ worktree, result: "already_gone" })}\n`;
    }
    const removed = await git(["worktree", "remove", worktree], cwd);
    if (removed.code !== 0) {
        throw new GitFailed(`git worktree remove ${worktree} failed: ${withoutPeriod(removed.stderr.trim())}.`);
    }
    return `${JSON.stringify({ worktree, result: "removed" })}\n`;
}

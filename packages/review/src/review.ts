// The mizcode-review command: pick the subcommand, run it, and print its
// result or a JSON error. runReview returns the exit code instead of exiting,
// so tests can call it.

import { GitHubClientError, type ClientOptions, type Output } from "@mizcode-reviewer/server";
import { GitFailed, cleanup } from "./cleanup.js";
import { BadInput, NotConfigured } from "./config.js";
import { gather } from "./gather.js";

export interface RunOptions extends ClientOptions {
  // Where gather looks for the clone, and cleanup runs git when the state
  // names no repo root. Default: process.cwd().
  cwd?: string;
  // The home directory that holds .config/mizcode-reviewer. Default: os.homedir().
  home?: string;
  // Where gather makes the workdir. Default: os.tmpdir().
  tmpdir?: string;
}

export const USAGE = `Usage: mizcode-review <command> [options]

Commands:
  gather <pr> [--repo <owner/name>]  Stage the pull request for review in a new temp workdir
  cleanup --workdir <dir>            Remove the worktree gather made

Run mizcode-review <command> --help for a command's options.

Settings: ~/.config/mizcode-reviewer/config.json holds {"app_id": <id>} and,
optionally, "key_file", which defaults to app.pem beside it.

Output is JSON on stdout. Errors are {"error": "...", "message": "..."} on stderr.

Exit codes:
  0  done
  1  not_installed, github_error or git_error
  2  bad_input
  4  not_configured
`;

const COMMANDS: Record<string, (argv: string[], options: RunOptions) => Promise<string>> = { gather, cleanup };

function withoutPeriod(text: string): string {
  return text.replace(/\.+$/, "");
}

function fail(output: Output, exitCode: number, error: Record<string, unknown>): number {
  output.stderr(`${JSON.stringify(error)}\n`);
  return exitCode;
}

function githubAdvice(status: number | undefined): string {
  if (status === 401) {
    return "Check that key_file belongs to the App in app_id and that this machine's clock is correct.";
  }
  if (status === 403) {
    return "Check that the App has pull requests read permission and that its installation includes this repository.";
  }
  if (status === 404) return "Check --repo and the pull request number.";
  if (status !== undefined && status >= 500) return "GitHub had a problem. Try again in a few minutes.";
  return "Fix the cause GitHub names and run again.";
}

export async function runReview(argv: string[], output: Output, options: RunOptions = {}): Promise<number> {
  const [name, ...rest] = argv;
  if (name === "--help" || name === "-h") {
    output.stdout(USAGE);
    return 0;
  }
  if (name === undefined) {
    return fail(output, 2, { error: "bad_input", message: "Give a command. Run mizcode-review --help for usage." });
  }
  const command = COMMANDS[name];
  if (!command) {
    return fail(output, 2, {
      error: "bad_input",
      message: `Unknown command "${name}". Run mizcode-review --help for usage.`,
    });
  }

  try {
    output.stdout(await command(rest, options));
    return 0;
  } catch (error) {
    if (error instanceof BadInput) return fail(output, 2, { error: "bad_input", message: error.message });
    if (error instanceof NotConfigured) return fail(output, 4, { error: "not_configured", message: error.message });
    if (error instanceof GitFailed) return fail(output, 1, { error: "git_error", message: error.message });
    if (error instanceof GitHubClientError) {
      if (error.code === "not_installed") return fail(output, 1, { error: "not_installed", message: error.message });
      return fail(output, 1, {
        error: "github_error",
        message: `${withoutPeriod(error.message)}. ${githubAdvice(error.status)}`,
        status: error.status,
      });
    }
    if (error instanceof TypeError && (error as Error & { cause?: unknown }).cause !== undefined) {
      // fetch throws without an HTTP status when GitHub cannot be reached.
      const cause = (error as Error & { cause: Error }).cause;
      return fail(output, 1, {
        error: "github_error",
        message: `Could not complete the request to GitHub: ${withoutPeriod(cause.message ?? error.message)}. Check the network connection and run again.`,
      });
    }
    throw error;
  }
}

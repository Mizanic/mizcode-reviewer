#!/usr/bin/env node
// The mizcode-review executable. The command itself is in review.ts.

import { runReview } from "./review.js";

process.exitCode = await runReview(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

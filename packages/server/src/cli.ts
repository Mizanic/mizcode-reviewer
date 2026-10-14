#!/usr/bin/env node
// The post-review executable. The command itself is in post-review.ts.

import { runPostReview } from "./post-review.js";

process.exitCode = await runPostReview(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

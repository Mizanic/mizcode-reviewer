// The OpenCode plugin. `opencode plugin add` installs this repository as a
// package, and package.json's exports point OpenCode here. It adds the
// mizcode-reviewer skill and the mizcode-reviewer MCP server. OpenCode can't
// run a command to make the Authorization header, so the MCP server is the
// local relay `review.js mcp`, which forwards to the shared bot's server with
// the token from review.js login.

import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";

const skillFile = fileURLToPath(new URL("../skills/mizcode-reviewer/SKILL.md", import.meta.url));
const reviewJs = fileURLToPath(new URL("../skills/mizcode-reviewer/scripts/review.js", import.meta.url));

// Splits SKILL.md into its description and the text after the frontmatter.
// The description is a folded block: the indented lines under `description: >-`.
function readSkill() {
  const text = readFileSync(skillFile, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${skillFile} has no frontmatter.`);
  const lines = match[1].split("\n");
  const start = lines.findIndex((line) => line.startsWith("description:"));
  const folded = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    folded.push(line.trim());
  }
  return { description: folded.join(" "), content: text.slice(match[0].length) };
}

export default {
  id: "mizcode-reviewer",
  async setup(ctx) {
    const { description, content } = readSkill();
    await ctx.skill.transform((editor) => {
      editor.add({ id: "mizcode-reviewer", name: "mizcode-reviewer", description, path: skillFile, content });
    });
    await ctx.mcp.transform((editor) => {
      editor.set("mizcode-reviewer", { type: "local", command: ["node", reviewJs, "mcp"] });
    });
  },
};

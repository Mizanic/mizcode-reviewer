import { describe, expect, it } from "vitest";

// TODO(#6): replace with real tests.
describe("@mizcode-reviewer/server", () => {
  it("imports", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeTypeOf("object");
  });
});

import { describe, expect, it } from "vitest";

// TODO(P1): replace with real tests.
describe("@mizcode-reviewer/server", () => {
  it("imports without starting a server", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeTypeOf("object");
  });

  it("exports nothing yet", async () => {
    const mod = await import("../src/index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});

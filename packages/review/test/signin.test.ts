import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_ID } from "../src/signin.js";
import { home, mockGitHub, run } from "./helpers.js";

const T0 = 1_800_000_000_000;
const HOUR = 3600 * 1000;

function tokenFile(dir: string): string {
  return join(dir, ".config", "mizcode-reviewer", "token.json");
}

// Options with a fake clock that sleep moves forward, and the progress text.
function setup(responses: Array<{ status: number; body: unknown }>) {
  const github = mockGitHub(responses);
  let clock = T0;
  const sleeps: number[] = [];
  const progress: string[] = [];
  const dir = home({});
  const options = {
    ...github.options,
    home: dir,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    progress: (text: string) => progress.push(text),
  };
  return { github, options, sleeps, progress, dir, advance: (ms: number) => (clock += ms) };
}

const device = {
  status: 200,
  body: {
    device_code: "dev123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  },
};
const pending = { status: 200, body: { error: "authorization_pending" } };
const granted = {
  status: 200,
  body: {
    access_token: "ghu_first",
    expires_in: 28800,
    refresh_token: "ghr_first",
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
  },
};

describe("review.js login", () => {
  it("shows the code, waits for it to be entered, and saves the token for this user only", async () => {
    const { github, options, sleeps, progress, dir } = setup([device, pending, granted]);

    const result = await run(["login"], options);

    expect(result.code).toBe(0);
    expect(progress.join("")).toBe("Open https://github.com/login/device on any device and enter the code ABCD-1234\n");
    expect(sleeps).toEqual([5000, 5000]);
    expect(github.calls[0]).toMatchObject({ url: "https://github.com/login/device/code", body: { client_id: CLIENT_ID } });
    expect(github.calls[1]?.body).toEqual({
      client_id: CLIENT_ID,
      device_code: "dev123",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(JSON.parse(readFileSync(tokenFile(dir), "utf8"))).toEqual({
      access_token: "ghu_first",
      expires_at: T0 + 10000 + 28800 * 1000,
      refresh_token: "ghr_first",
      refresh_token_expires_at: T0 + 10000 + 15897600 * 1000,
    });
    expect(statSync(tokenFile(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.stdout)).toEqual({ signed_in: true, token_file: tokenFile(dir) });
  });

  it("waits longer when GitHub says slow_down", async () => {
    const { options, sleeps } = setup([device, { status: 200, body: { error: "slow_down", interval: 10 } }, granted]);

    expect((await run(["login"], options)).code).toBe(0);
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("fails with sign_in_failed when the user cancels on GitHub", async () => {
    const { options } = setup([device, { status: 200, body: { error: "access_denied" } }]);

    const result = await run(["login"], options);

    expect(result.code).toBe(1);
    expect(result.error).toEqual({ error: "sign_in_failed", message: "The sign-in was cancelled on GitHub." });
  });

  it("fails with sign_in_failed when the code expires", async () => {
    const short = { status: 200, body: { ...device.body, expires_in: 8 } };
    const { options } = setup([short, pending, pending]);

    const result = await run(["login"], options);

    expect(result.code).toBe(1);
    expect(result.error?.error).toBe("sign_in_failed");
    expect(String(result.error?.message)).toContain("expired");
  });

  it("fails with sign_in_failed when device sign-in is turned off for the App", async () => {
    const { options } = setup([
      {
        status: 200,
        body: { error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" },
      },
    ]);

    const result = await run(["login"], options);

    expect(result.code).toBe(1);
    expect(result.error?.message).toBe(
      "GitHub refused to start the sign-in: Device Flow must be explicitly enabled for this App.",
    );
  });
});

describe("review.js token", () => {
  function saved(dir: string, token: Record<string, unknown>): void {
    writeFileSync(tokenFile(dir), JSON.stringify(token));
  }

  it("prints the Authorization header for a saved token that has not expired", async () => {
    const { github, options, dir } = setup([]);
    saved(dir, { access_token: "ghu_first", expires_at: T0 + HOUR, refresh_token: "ghr_first" });

    const result = await run(["token"], options);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_first" });
    expect(github.calls).toHaveLength(0);
  });

  it("refreshes an expired token without the client secret and saves the new one", async () => {
    const refreshed = { status: 200, body: { ...granted.body, access_token: "ghu_second", refresh_token: "ghr_second" } };
    const { github, options, dir } = setup([refreshed]);
    saved(dir, {
      access_token: "ghu_first",
      expires_at: T0 + 60 * 1000,
      refresh_token: "ghr_first",
      refresh_token_expires_at: T0 + 100 * HOUR,
    });

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls[0]).toMatchObject({
      url: "https://github.com/login/oauth/access_token",
      body: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "ghr_first" },
    });
    expect(JSON.parse(readFileSync(tokenFile(dir), "utf8")).refresh_token).toBe("ghr_second");
  });

  it.each([
    ["there is no saved token", undefined, []],
    ["the refresh token has expired", { access_token: "a", expires_at: T0 - 1, refresh_token: "r", refresh_token_expires_at: T0 - 1 }, []],
    ["GitHub refuses the refresh", { access_token: "a", expires_at: T0 - 1, refresh_token: "r" }, [{ status: 200, body: { error: "bad_refresh_token" } }]],
    ["GitHub cannot be reached", { access_token: "a", expires_at: T0 - 1, refresh_token: "r" }, []],
  ])("prints {} and exits 0 when %s", async (_name, token, responses) => {
    const { options, dir } = setup(responses as Array<{ status: number; body: unknown }>);
    if (token) saved(dir, token);

    const result = await run(["token"], options);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("{}\n");
  });
});

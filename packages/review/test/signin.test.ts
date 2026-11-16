import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_ID, userToken } from "../src/signin.js";
import { home, mockGitHub, run } from "./helpers.js";

const T0 = 1_800_000_000_000;
const HOUR = 3600 * 1000;

function tokenFile(dir: string): string {
  return join(dir, ".config", "mizcode-reviewer", "token.json");
}

// Options with a fake clock that sleep moves forward.
function setup(responses: Array<{ status: number; body: unknown }>) {
  const github = mockGitHub(responses);
  let clock = T0;
  const sleeps: number[] = [];
  const dir = home({});
  const options = {
    ...github.options,
    home: dir,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { github, options, sleeps, dir };
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

function pendingFile(dir: string): string {
  return join(dir, ".config", "mizcode-reviewer", "login.json");
}

describe("review.js login", () => {
  it("prints the code and the URL, ends at once, and keeps the device code for --wait", async () => {
    const { github, options, sleeps, dir } = setup([device]);

    const result = await run(["login"], options);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900,
    });
    expect(sleeps).toEqual([]);
    expect(github.calls[0]).toMatchObject({ url: "https://github.com/login/device/code", body: { client_id: CLIENT_ID } });
    expect(JSON.parse(readFileSync(pendingFile(dir), "utf8"))).toEqual({
      device_code: "dev123",
      interval: 5,
      expires_at: T0 + 900 * 1000,
    });
    expect(statSync(pendingFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("--wait saves the token for this user only once the code is entered", async () => {
    const { github, options, sleeps, dir } = setup([device, pending, granted]);
    await run(["login"], options);

    const result = await run(["login", "--wait"], options);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "signed_in", token_file: tokenFile(dir) });
    expect(sleeps).toEqual([5000, 5000]);
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
    expect(existsSync(pendingFile(dir))).toBe(false);
  });

  it("--wait reports waiting after 100 seconds and keeps the device code for the next call", async () => {
    const { options, sleeps, dir } = setup([device, ...Array.from({ length: 20 }, () => pending)]);
    await run(["login"], options);

    const result = await run(["login", "--wait"], options);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "waiting" });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(100 * 1000);
    expect(existsSync(pendingFile(dir))).toBe(true);
  });

  it("--wait waits longer when GitHub says slow_down", async () => {
    const { options, sleeps } = setup([device, { status: 200, body: { error: "slow_down", interval: 10 } }, granted]);
    await run(["login"], options);

    expect((await run(["login", "--wait"], options)).code).toBe(0);
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("--wait keeps the longer slow_down interval for the next --wait call", async () => {
    const slowDown = { status: 200, body: { error: "slow_down", interval: 10 } };
    const { options, sleeps, dir } = setup([device, slowDown, ...Array.from({ length: 12 }, () => pending), granted]);
    await run(["login"], options);

    expect(JSON.parse((await run(["login", "--wait"], options)).stdout)).toEqual({ status: "waiting" });
    expect(JSON.parse(readFileSync(pendingFile(dir), "utf8")).interval).toBe(10);
    sleeps.length = 0;
    expect(JSON.parse((await run(["login", "--wait"], options)).stdout).status).toBe("signed_in");
    expect(sleeps.every((ms) => ms === 10000)).toBe(true);
  });

  it("--wait fails with sign_in_failed when the user cancels on GitHub", async () => {
    const { options, dir } = setup([device, { status: 200, body: { error: "access_denied" } }]);
    await run(["login"], options);

    const result = await run(["login", "--wait"], options);

    expect(result.code).toBe(1);
    expect(result.error).toEqual({ error: "sign_in_failed", message: "The sign-in was cancelled on GitHub." });
    expect(existsSync(pendingFile(dir))).toBe(false);
  });

  it("--wait fails with sign_in_failed when the code expires", async () => {
    const short = { status: 200, body: { ...device.body, expires_in: 8 } };
    const { options, dir } = setup([short, pending, pending]);
    await run(["login"], options);

    const result = await run(["login", "--wait"], options);

    expect(result.code).toBe(1);
    expect(result.error?.error).toBe("sign_in_failed");
    expect(String(result.error?.message)).toContain("expired");
    expect(existsSync(pendingFile(dir))).toBe(false);
  });

  it("--wait without a login first is bad_input", async () => {
    const { options, github } = setup([]);

    const result = await run(["login", "--wait"], options);

    expect(result.code).toBe(2);
    expect(result.error?.message).toBe("There is no sign-in in progress. Run review.js login first.");
    expect(github.calls).toHaveLength(0);
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

  function lockFile(dir: string): string {
    return join(dir, ".config", "mizcode-reviewer", "refresh.lock");
  }
  const expired = { access_token: "ghu_first", expires_at: T0 - 1, refresh_token: "ghr_first" };
  const refreshed = { status: 200, body: { ...granted.body, access_token: "ghu_second", refresh_token: "ghr_second" } };

  it("waits while another process refreshes, then uses the token it saved without refreshing again", async () => {
    const { github, options, dir, sleeps } = setup([]);
    saved(dir, expired);
    writeFileSync(lockFile(dir), "");
    const sleepFirst = options.sleep;
    options.sleep = async (ms: number) => {
      await sleepFirst(ms);
      // The other process saves its new token and releases the lock.
      saved(dir, { access_token: "ghu_other", expires_at: T0 + 8 * HOUR, refresh_token: "ghr_other" });
      rmSync(lockFile(dir));
    };

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_other" });
    expect(github.calls).toHaveLength(0);
    expect(sleeps).toEqual([100]);
  });

  it("takes the lock, refreshes, and releases the lock", async () => {
    const { github, options, dir } = setup([refreshed]);
    saved(dir, expired);
    let lockedDuringRefresh = false;
    const fetchFirst = options.fetch!;
    options.fetch = async (url, init) => {
      lockedDuringRefresh = existsSync(lockFile(dir));
      return fetchFirst(url, init);
    };

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls).toHaveLength(1);
    expect(lockedDuringRefresh).toBe(true);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it.each([
    ["GitHub refuses the refresh", [{ status: 200, body: { error: "bad_refresh_token" } }]],
    ["GitHub cannot be reached", []],
  ])("releases the lock when %s", async (_name, responses) => {
    const { options, dir } = setup(responses as Array<{ status: number; body: unknown }>);
    saved(dir, expired);

    const result = await run(["token"], options);

    expect(result.stdout).toBe("{}\n");
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("removes a lock left by a process that died, and refreshes", async () => {
    const { github, options, dir, sleeps } = setup([refreshed]);
    saved(dir, expired);
    writeFileSync(lockFile(dir), "");
    const old = new Date(Date.now() - 60 * 1000);
    utimesSync(lockFile(dir), old, old);

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("refreshes anyway after waiting 15 seconds for a lock that is not released, and leaves that lock", async () => {
    const { github, options, dir, sleeps } = setup([refreshed]);
    saved(dir, expired);
    writeFileSync(lockFile(dir), "");

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls).toHaveLength(1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(15 * 1000);
    expect(existsSync(lockFile(dir))).toBe(true);
  });

  it("gather waits for the lock too", async () => {
    const { options, dir } = setup([]);
    saved(dir, expired);
    writeFileSync(lockFile(dir), "");
    const sleepFirst = options.sleep;
    options.sleep = async (ms: number) => {
      await sleepFirst(ms);
      saved(dir, { access_token: "ghu_other", expires_at: T0 + 8 * HOUR, refresh_token: "ghr_other" });
      rmSync(lockFile(dir));
    };

    await expect(userToken(options)).resolves.toBe("ghu_other");
  });

  it("leaves a lock another process took after this one's lock was removed as stale", async () => {
    const { github, options, dir } = setup([refreshed]);
    saved(dir, expired);
    const fetchFirst = options.fetch!;
    options.fetch = async (url, init) => {
      // This refresh took so long that another process removed the lock as stale and took its own.
      rmSync(lockFile(dir));
      writeFileSync(lockFile(dir), "other");
      return fetchFirst(url, init);
    };

    await run(["token"], options);

    expect(github.calls).toHaveLength(1);
    expect(readFileSync(lockFile(dir), "utf8")).toBe("other");
  });

  it("does not remove a stale lock while another process holds the guard for removing it", async () => {
    const { github, options, dir, sleeps } = setup([refreshed]);
    saved(dir, expired);
    writeFileSync(lockFile(dir), "");
    const old = new Date(Date.now() - 60 * 1000);
    utimesSync(lockFile(dir), old, old);
    writeFileSync(`${lockFile(dir)}.reclaim`, "");
    const sleepFirst = options.sleep;
    options.sleep = async (ms: number) => {
      await sleepFirst(ms);
      // The guard's holder removes the stale lock and releases the guard.
      rmSync(lockFile(dir), { force: true });
      rmSync(`${lockFile(dir)}.reclaim`, { force: true });
    };

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls).toHaveLength(1);
    expect(sleeps).toEqual([100]);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("removes a guard left by a process that died while removing a stale lock", async () => {
    const { github, options, dir } = setup([refreshed]);
    saved(dir, expired);
    const old = new Date(Date.now() - 60 * 1000);
    for (const file of [lockFile(dir), `${lockFile(dir)}.reclaim`]) {
      writeFileSync(file, "");
      utimesSync(file, old, old);
    }

    const result = await run(["token"], options);

    expect(JSON.parse(result.stdout)).toEqual({ Authorization: "Bearer ghu_second" });
    expect(github.calls).toHaveLength(1);
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(existsSync(`${lockFile(dir)}.reclaim`)).toBe(false);
  });

  // Real clock and real sleeps: the processes overlap only if time passes.
  it.each([
    ["no lock", false],
    ["a lock left by a process that died", true],
  ])("refreshes once when eight processes find the token expired at the same moment, with %s", async (_name, stale) => {
    const dir = home({});
    saved(dir, { access_token: "ghu_first", expires_at: Date.now() - 1, refresh_token: "ghr_first" });
    if (stale) {
      writeFileSync(lockFile(dir), "");
      const old = new Date(Date.now() - 60 * 1000);
      utimesSync(lockFile(dir), old, old);
    }
    let refreshes = 0;
    const options = {
      home: dir,
      fetch: async () => {
        refreshes += 1;
        await new Promise((done) => setTimeout(done, 50));
        return new Response(
          JSON.stringify(refreshes === 1 ? refreshed.body : { error: "bad_refresh_token" }),
          { status: 200 },
        );
      },
    };

    const tokens = await Promise.all(Array.from({ length: 8 }, () => userToken(options)));

    expect(tokens).toEqual(Array(8).fill("ghu_second"));
    expect(refreshes).toBe(1);
    expect(existsSync(lockFile(dir))).toBe(false);
  });

  it("does not take the lock when the refresh token has expired", async () => {
    const { github, options, dir, sleeps } = setup([]);
    saved(dir, { ...expired, refresh_token_expires_at: T0 - 1 });
    writeFileSync(lockFile(dir), "");

    const result = await run(["token"], options);

    expect(result.stdout).toBe("{}\n");
    expect(github.calls).toHaveLength(0);
    expect(sleeps).toEqual([]);
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

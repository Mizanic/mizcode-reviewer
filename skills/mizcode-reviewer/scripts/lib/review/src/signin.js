// Sign-in for the shared bot. review.js login starts GitHub's device flow for
// the mizcode-reviewer App and prints the code; review.js login --wait waits
// for the user to enter it and saves the user access token in
// ~/.config/mizcode-reviewer/token.json. They are two commands because an AI
// tool shows a command's output only when the command ends. review.js token prints the
// Authorization header for the MCP server, refreshing the token first if it
// has expired. The token stays on this machine. The server only asks GitHub
// whether the token is the App's and whose it is.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BadInput, configDir } from "./config.js";
// The mizcode-reviewer App's client ID. It is public: GitHub shows it on the
// sign-in page.
export const CLIENT_ID = "Iv23libdXUQOTm5d8vFp";
const GITHUB_URL = "https://github.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Refresh this long before the token expires, so a call never starts with a
// token that runs out on the way.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// GitHub accepts a refresh token once, so only one process refreshes at a
// time. A lock older than LOCK_STALE_MS was left by a process that died. A
// process waits at most LOCK_WAIT_MS for the lock, then refreshes anyway.
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 15 * 1000;
const LOCK_POLL_MS = 100;
// How long one login --wait call waits before it reports "waiting". It stays
// under the two minutes an AI tool's shell command gets by default.
const WAIT_SECONDS = 100;
export class SignInFailed extends Error {
}
// No usable token: the user has to run review.js login.
export class NotSignedIn extends Error {
}
export const LOGIN_USAGE = `Usage: review.js login [--wait]

Signs in to GitHub for the shared mizcode-reviewer bot, once per machine.

review.js login prints {"verification_uri", "user_code", "expires_in"} and
ends. Show the user the URL and the code: they open the URL on any device and
enter the code.

review.js login --wait then waits up to ${WAIT_SECONDS} seconds for the code to be
entered. It prints {"status": "signed_in"} when the token is saved, or
{"status": "waiting"}: run it again. The token is saved in
~/.config/mizcode-reviewer/token.json, on this machine only.

Options:
  --wait      Wait for the code from the last review.js login to be entered
  -h, --help  Show this help
`;
export const TOKEN_USAGE = `Usage: review.js token

Prints {"Authorization": "Bearer <token>"} for the mizcode-reviewer MCP
server, refreshing the saved token first if it has expired. Prints {} if
there is no usable token: run review.js login.

Options:
  -h, --help  Show this help
`;
function tokenPath(options) {
    return join(configDir(options.home ?? homedir()), "token.json");
}
// The device code from the last review.js login, kept until --wait ends.
function pendingPath(options) {
    return join(configDir(options.home ?? homedir()), "login.json");
}
function lockPath(options) {
    return join(configDir(options.home ?? homedir()), "refresh.lock");
}
function now(options) {
    return options.now?.() ?? Date.now();
}
async function postForm(options, path, body) {
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(`${GITHUB_URL}${path}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "mizcode-reviewer" },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        throw new SignInFailed(`GitHub returned ${response.status} for ${path}.`);
    return (await response.json());
}
function toSaved(response, at) {
    const saved = { access_token: response.access_token };
    if (response.expires_in !== undefined)
        saved.expires_at = at + response.expires_in * 1000;
    if (response.refresh_token !== undefined)
        saved.refresh_token = response.refresh_token;
    if (response.refresh_token_expires_in !== undefined) {
        saved.refresh_token_expires_at = at + response.refresh_token_expires_in * 1000;
    }
    return saved;
}
async function writePrivate(path, value) {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
}
async function save(options, token) {
    await writePrivate(tokenPath(options), token);
}
async function load(options) {
    try {
        const data = JSON.parse(await readFile(tokenPath(options), "utf8"));
        return typeof data.access_token === "string" ? data : null;
    }
    catch {
        return null;
    }
}
function sleep(options, ms) {
    return options.sleep ? options.sleep(ms) : new Promise((done) => setTimeout(done, ms));
}
function parseFlags(argv, command, flags = []) {
    const options = { help: { type: "boolean", short: "h" } };
    for (const flag of flags)
        options[flag] = { type: "boolean" };
    try {
        return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
    }
    catch (error) {
        throw new BadInput(`${error.message.replace(/\.+$/, "")}. Run review.js ${command} --help for usage.`);
    }
}
async function startLogin(options) {
    const device = (await postForm(options, "/login/device/code", { client_id: CLIENT_ID }));
    if (device.error || !device.device_code || !device.user_code) {
        throw new SignInFailed(`GitHub refused to start the sign-in: ${device.error_description ?? device.error}.`);
    }
    const expiresIn = device.expires_in ?? 900;
    const pending = {
        device_code: device.device_code,
        interval: device.interval ?? 5,
        expires_at: now(options) + expiresIn * 1000,
    };
    await writePrivate(pendingPath(options), pending);
    return `${JSON.stringify({
        verification_uri: device.verification_uri ?? `${GITHUB_URL}/login/device`,
        user_code: device.user_code,
        expires_in: expiresIn,
    })}\n`;
}
async function waitForLogin(options) {
    let pending;
    try {
        pending = JSON.parse(await readFile(pendingPath(options), "utf8"));
    }
    catch {
        throw new BadInput("There is no sign-in in progress. Run review.js login first.");
    }
    let interval = pending.interval * 1000;
    const stopAt = Math.min(pending.expires_at, now(options) + WAIT_SECONDS * 1000);
    while (now(options) < stopAt) {
        await sleep(options, interval);
        const response = await postForm(options, "/login/oauth/access_token", {
            client_id: CLIENT_ID,
            device_code: pending.device_code,
            grant_type: DEVICE_GRANT,
        });
        if (response.access_token) {
            await save(options, toSaved(response, now(options)));
            await rm(pendingPath(options), { force: true });
            return `${JSON.stringify({ status: "signed_in", token_file: tokenPath(options) })}\n`;
        }
        if (response.error === "authorization_pending")
            continue;
        if (response.error === "slow_down") {
            interval = (response.interval ?? interval / 1000 + 5) * 1000;
            // Keep the longer interval for the next --wait call too.
            pending = { ...pending, interval: interval / 1000 };
            await writePrivate(pendingPath(options), pending);
            continue;
        }
        await rm(pendingPath(options), { force: true });
        if (response.error === "access_denied")
            throw new SignInFailed("The sign-in was cancelled on GitHub.");
        if (response.error === "expired_token") {
            throw new SignInFailed("The code expired before it was entered. Run review.js login again.");
        }
        throw new SignInFailed(`GitHub refused the sign-in: ${response.error_description ?? response.error}.`);
    }
    if (now(options) >= pending.expires_at) {
        await rm(pendingPath(options), { force: true });
        throw new SignInFailed("The code expired before it was entered. Run review.js login again.");
    }
    return `${JSON.stringify({ status: "waiting" })}\n`;
}
export async function login(argv, options) {
    const flags = parseFlags(argv, "login", ["wait"]);
    if (flags.help)
        return LOGIN_USAGE;
    return flags.wait ? waitForLogin(options) : startLogin(options);
}
function usable(saved, at) {
    return saved.expires_at === undefined || saved.expires_at - REFRESH_MARGIN_MS > at;
}
// Creates the lock file at path with a new random ID in it. Returns the ID,
// or null if the file exists. The ID, not the inode, tells a process whether
// the lock is still its own: a file system can give a new file the inode of
// one just removed.
async function tryLock(path) {
    const id = randomUUID();
    try {
        const file = await open(path, "wx", 0o600);
        try {
            await file.writeFile(id);
        }
        finally {
            await file.close();
        }
        return id;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return null;
        throw error;
    }
}
function isStale(lock) {
    return Date.now() - lock.mtimeMs > LOCK_STALE_MS;
}
// Removes the refresh lock if a process that died left it. One process at a
// time does this, holding a second lock: otherwise two processes can both see
// the old lock, and the second removes the new lock the first just took.
// Returns true if this process removed it.
async function removeStaleLock(path) {
    const guard = `${path}.reclaim`;
    if ((await tryLock(guard)) === null) {
        // A guard this old was left by a process that died while removing a lock.
        const old = await stat(guard).catch(() => null);
        if (old && isStale(old))
            await rm(guard, { force: true });
        return false;
    }
    try {
        const lock = await stat(path).catch(() => null);
        if (!lock || !isStale(lock))
            return false;
        await rm(path, { force: true });
        return true;
    }
    finally {
        await rm(guard, { force: true });
    }
}
// Runs refresh while holding the refresh lock. Gather and the MCP client's
// headers helper can both find the token expired at the same moment: without
// the lock, GitHub refuses the second refresh and that process has no token.
async function withRefreshLock(options, refresh) {
    const path = lockPath(options);
    const giveUpAt = now(options) + LOCK_WAIT_MS;
    let held = null;
    while (held === null) {
        held = await tryLock(path);
        if (held !== null)
            break;
        const lock = await stat(path).catch(() => null);
        if (lock && isStale(lock) && (await removeStaleLock(path)))
            continue;
        if (now(options) >= giveUpAt)
            break;
        await sleep(options, LOCK_POLL_MS);
    }
    try {
        return await refresh();
    }
    finally {
        // Remove the lock only if it is still the one this process made.
        if (held !== null && (await readFile(path, "utf8").catch(() => null)) === held)
            await rm(path, { force: true });
    }
}
// Returns a usable access token, refreshing it if it has expired, or null.
async function currentToken(options) {
    const first = await load(options);
    if (!first)
        return null;
    if (usable(first, now(options)))
        return first.access_token;
    if (!first.refresh_token || (first.refresh_token_expires_at ?? Infinity) <= now(options))
        return null;
    return withRefreshLock(options, async () => {
        // Another process may have refreshed while this one waited for the lock.
        const saved = await load(options);
        if (!saved)
            return null;
        const at = now(options);
        if (usable(saved, at))
            return saved.access_token;
        if (!saved.refresh_token || (saved.refresh_token_expires_at ?? Infinity) <= at)
            return null;
        // A device flow token refreshes without the client secret.
        const response = await postForm(options, "/login/oauth/access_token", {
            client_id: CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: saved.refresh_token,
        });
        if (!response.access_token)
            return null;
        await save(options, toSaved(response, at));
        return response.access_token;
    });
}
// The signed-in user's token, for reading the pull request.
export async function userToken(options) {
    const value = await currentToken(options);
    if (value === null) {
        throw new NotSignedIn("Not signed in to the shared mizcode-reviewer bot. Run review.js login.");
    }
    return value;
}
// The Authorization header for the MCP server, or {} if there is no usable
// token. It never fails: without a token the server answers 403 to a tool
// call.
export async function authHeader(options) {
    let value;
    try {
        value = await currentToken(options);
    }
    catch {
        value = null;
    }
    return value ? { Authorization: `Bearer ${value}` } : {};
}
// Claude Code and Codex run this before they connect.
export async function token(argv, options) {
    if (parseFlags(argv, "token").help)
        return TOKEN_USAGE;
    return `${JSON.stringify(await authHeader(options))}\n`;
}

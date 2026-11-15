// Reads the App settings from ~/.config/mizcode-reviewer/config.json: app_id,
// and key_file, which defaults to app.pem beside the config file.
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
export class BadInput extends Error {
}
export class NotConfigured extends Error {
}
// review.js agent: the tool failed, timed out, or printed something that is
// not a review.
export class AgentFailed extends Error {
}
// review.js agent: the tool ran and said it could not finish the review.
export class ReviewIncomplete extends Error {
}
export function configDir(home = homedir()) {
    return join(home, ".config", "mizcode-reviewer");
}
function withoutPeriod(text) {
    return text.replace(/\.+$/, "");
}
// "~/" means the home directory. Any other relative path is relative to the
// config directory, not to wherever the command runs.
function keyPath(value, dir, home) {
    if (value === "~" || value.startsWith("~/"))
        return join(home, value.slice(1));
    return isAbsolute(value) ? value : resolve(dir, value);
}
export async function loadConfig(home = homedir()) {
    const dir = configDir(home);
    const path = join(dir, "config.json");
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new NotConfigured(`${path} does not exist. Create it with {"app_id": <your App's ID>} and put the App's private key at ${join(dir, "app.pem")}.`);
        }
        throw new BadInput(`Could not read ${path}: ${withoutPeriod(error.message)}.`);
    }
    let data;
    try {
        data = JSON.parse(text);
    }
    catch (error) {
        throw new BadInput(`${path} is not valid JSON: ${withoutPeriod(error.message)}. Fix the file and run again.`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new BadInput(`${path} must be a JSON object with app_id and, optionally, key_file.`);
    }
    const config = data;
    const unknown = Object.keys(config).filter((key) => key !== "app_id" && key !== "key_file");
    if (unknown.length > 0) {
        throw new BadInput(`${path} has unknown fields ${unknown.join(", ")}; allowed fields are app_id, key_file.`);
    }
    if (config.app_id === undefined) {
        throw new NotConfigured(`${path} has no app_id. Add the App's ID, from the App's settings page.`);
    }
    const appId = String(config.app_id);
    if (!(typeof config.app_id === "number" || typeof config.app_id === "string") || !/^[1-9]\d*$/.test(appId)) {
        throw new BadInput(`app_id in ${path} must be the App's numeric ID, not ${JSON.stringify(config.app_id)}.`);
    }
    if (config.key_file !== undefined && (typeof config.key_file !== "string" || config.key_file.trim() === "")) {
        throw new BadInput(`key_file in ${path} must be a path to the App's private key.`);
    }
    const keyFile = keyPath(config.key_file ?? "app.pem", dir, home);
    let privateKey;
    try {
        privateKey = await readFile(keyFile, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new BadInput(`The key file ${keyFile} does not exist. Check key_file in ${path}.`);
        }
        throw new BadInput(`Could not read the key file ${keyFile}: ${withoutPeriod(error.message)}.`);
    }
    // GitHub App keys are RSA. Checking here turns a wrong file into bad_input
    // instead of a 401 from GitHub.
    let type;
    try {
        type = createPrivateKey(privateKey).asymmetricKeyType;
    }
    catch {
        type = undefined;
    }
    if (type !== "rsa") {
        throw new BadInput(`The key file ${keyFile} is not an RSA private key in PEM format. Use the .pem file downloaded from the App's settings page.`);
    }
    return { appId, privateKey };
}

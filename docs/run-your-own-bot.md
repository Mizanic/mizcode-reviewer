# Run the review skill as your own bot

This guide takes you from nothing to a pull request review posted by your own GitHub App, for example `acme-review[bot]`. Nothing in it needs a server. The review is written on your machine by your AI tool, and the skill's script posts it to GitHub with your App's private key, which never leaves your machine.

You need:

- A GitHub account that can create a GitHub App on the account or organization that owns the repositories you review.
- Node.js 22 or later and git on the machine that runs the review.
- Claude Code or Codex, with your own subscription.

## 1. Register the App

[github-app-manifest.json](github-app-manifest.json) lists what the App needs. Register the App by hand in GitHub's form with the values below. The manifest file exists for GitHub's manifest flow, which needs a web page that posts the manifest and a URL that receives a code back, so it does not help when you only have a browser.

Open the form. For a personal account it is at `https://github.com/settings/apps/new`. For an organization it is `https://github.com/organizations/<org>/settings/apps/new`. Then:

1. Enter a name. GitHub makes the bot's login from it: a name of `Acme Review` posts as `acme-review[bot]`. The name must be unique across GitHub.
2. Enter a homepage URL. The manifest uses `https://github.com/Mizanic/mizcode-reviewer`. Any URL you own works too.
3. Under "Webhook", clear "Active". The skill receives no events, and GitHub refuses a webhook with no URL.
4. Under "Permissions", open "Repository permissions" and set "Pull requests" to "Read and write". GitHub adds "Metadata: Read-only" on its own. Leave every other permission at "No access".
5. Under "Where can this GitHub App be installed?", choose "Only on this account".
6. Click "Create GitHub App".

GitHub opens the App's settings page. Note the App ID shown near the top. You need it in step 3.

## 2. Save the private key

On the same settings page, scroll to "Private keys" and click "Generate a private key". GitHub downloads a `.pem` file. Move it where the skill looks for it, and keep it readable by you alone:

```sh
mkdir -p ~/.config/mizcode-reviewer
mv ~/Downloads/<name>.<date>.private-key.pem ~/.config/mizcode-reviewer/app.pem
chmod 600 ~/.config/mizcode-reviewer/app.pem
```

The file is an RSA private key in PEM format. The script checks that before it signs in, so a wrong file fails with a message instead of a 401 from GitHub. Anyone who holds this file can post reviews as your bot on every repository the App is installed on. Do not commit it and do not paste it into a chat.

## 3. Write the settings file

Create `~/.config/mizcode-reviewer/config.json` with the App ID from step 1:

```json
{ "app_id": 123456 }
```

The script reads the key from `app.pem` beside this file. To keep the key elsewhere, add `"key_file"` with its path. A path that starts with `~/` is in your home directory. Any other relative path is relative to `~/.config/mizcode-reviewer`. The file accepts no other field.

## 4. Install the App on a repository

Back on the App's settings page, click "Install App" in the left menu, then "Install" next to your account or organization. Choose "Only select repositories" and pick the repositories the bot may review. Click "Install".

The App can read and post on those repositories only. When `gather` or `post` reports `not_installed`, come back here and add the repository.

## 5. Build and install the skill

Clone this repository and build it. The build compiles the TypeScript into `skills/mizcode-reviewer/scripts/lib/`. After that, the skill folder runs on its own: it needs no `npm install`, no global link and no `node_modules`.

```sh
git clone https://github.com/Mizanic/mizcode-reviewer.git
cd mizcode-reviewer
npm ci
npm run build
```

Link or copy the skill folder where your AI tool looks for skills:

```sh
ln -s "$PWD/skills/mizcode-reviewer" ~/.claude/skills/mizcode-reviewer   # Claude Code
ln -s "$PWD/skills/mizcode-reviewer" ~/.agents/skills/mizcode-reviewer   # Codex
```

A copy works too, as long as it includes `scripts/lib/`. The folder's `SKILL.md` names `mizcode-reviewer[bot]` in its description. The script posts as whichever App the key in your settings file belongs to, so your reviews carry your bot's name without any edit to the skill.

## 6. Check the setup

From a clone of a repository the App is installed on, with an open pull request:

```sh
node ~/.claude/skills/mizcode-reviewer/scripts/review.js gather <pr>
```

On success it prints a JSON object with the pull request's title, its head SHA and the path of a temporary directory, the workdir. Then confirm posting works without posting anything:

```sh
echo '[]' > /tmp/findings.json
node ~/.claude/skills/mizcode-reviewer/scripts/review.js post --workdir <workdir> \
  --findings-file /tmp/findings.json --signed-by Check --dry-run
```

It prints the review it would post. Remove the worktree `gather` made:

```sh
node ~/.claude/skills/mizcode-reviewer/scripts/review.js cleanup --workdir <workdir>
```

If a command fails, it prints one JSON object on stderr. The message says what to fix:

| error | Fix |
|---|---|
| `not_configured` | Step 3: the settings file does not exist or has no `app_id` |
| `bad_input` naming the key file | Step 2: the key file is missing, or is not the `.pem` GitHub generated |
| `not_installed` | Step 4: install the App on this repository |
| `github_error` with status 401 | The App ID in step 3 and the key in step 2 belong to different Apps |

## 7. Review a pull request

In your AI tool, inside a clone of the repository, run:

```text
/mizcode-reviewer <pr>
```

Add `--repo owner/name` when the clone's `origin` is not the pull request's repository. The tool reads the pull request, writes the review and posts it as your bot. The review ends with a link to the posted review on GitHub.

To update the skill later, run `git pull`, `npm ci` and `npm run build` in the clone again. A copy of the folder needs copying again after that.

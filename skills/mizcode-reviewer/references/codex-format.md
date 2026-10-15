# GitHub review format

`review.js post` renders `findings.json`. Findings contain review
content; the command owns badges and the top-level summary.

## Top-level review

Keep the initial review body as an index, not a review diary:

```markdown
Reviewed `31ded9d53a` — 3 findings (1 P1, 2 P2).
```

With no findings:

```markdown
Reviewed `31ded9d53a` — no new issues found.
```

Submit this as a GitHub review even though it has no inline comments. A clean
result must be visible on the pull request, not only in chat.

Keep that wording exactly. Automation reads `no new issues found` as the
all-clear signal, and a PR with no review at all also has no findings — the
phrase is what separates "reviewed and clean" from "never reviewed."

P0, P1 and P2 findings are posted. `post` drops P3, so a review whose only
survivors were P3 renders this same all-clear sentence — the signal means
nothing merge-relevant, not that the ledger was empty.

## Unverified suspicions

A severe candidate that could not be proved is rendered under the summary:

```markdown
Reviewed `31ded9d53a` — no findings, 1 unverified.

Unverified — severe if real, could not be proved:

- `src/auth.ts:42` — A quoted-JSON groups claim parses wrong, locking out every admin. Check: log the raw claim from one deployed request.
```

Supply them with `--suspicions-file`. While any exist the summary does **not**
carry `no new issues found` — an unresolved severe candidate is not an
all-clear, and automation treats that sentence as ready-to-merge.

These belong on the pull request rather than in a chat reply. The loop that
reads this review is a program; anything not posted here is lost.

## Attribution and signature

`post` opens the body with a note naming who read the diff and closes it with a
hidden marker:

```markdown
> [!NOTE]
> 🤖 Reviewed by Claude/Opus-5

Reviewed `31ded9d53a` — no new issues found.

<!-- rehanhaider/pr-review-skill -->
```

The note comes from `--signed-by`, which is required and takes a harness/model
label: `Claude/Opus-5`, `Cursor/Grok-4.7`. GitHub renders it as a callout, so
a reader sees at a glance which model produced the review. Name the model that
actually ran; a label naming one that did not is a false record.

The HTML comment is what automation matches on. GitHub does not display it but
returns it through the API, and `post` always adds it, so no `--signed-by`
value can leave `forge`'s watcher unable to call the pull request clean. The
watcher skips the leading note before reading the verdict line, so the verdict
line still has to be exact.

The summary must not contain:

- praise or an explanation of correct code
- test commands or pass counts
- “checked and fine” cases
- resolved-thread history
- pre-existing or out-of-scope issues
- the agent's investigation or severity reasoning

P0, P1 and P2 findings always remain inline and are never capped.

## Inline finding

The renderer produces:

```markdown
**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Keep tenant scope on the fallback query**

When the primary lookup misses, this fallback queries by email alone. A user in one tenant can therefore receive another tenant's record when both use the same email. Include `tenantId` in the fallback predicate, matching the primary path.
```

Badge colors:

| Priority | Color |
| --- | --- |
| P0 | red |
| P1 | orange |
| P2 | yellow |
| P3 | lightgrey (recorded, not posted) |

## Writing rule

Use one root cause per thread. In 2–4 sentences:

1. Name the concrete trigger or path.
2. State the incorrect outcome and why it matters.
3. Point to the boundary that must change.

Use an imperative title. Avoid labels such as “Bug”, greetings, sign-offs,
review history, long code tours, and unneeded praise.

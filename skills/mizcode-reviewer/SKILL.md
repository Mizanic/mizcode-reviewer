---
name: mizcode-reviewer
description: >-
  Review a GitHub pull request for concrete defects introduced by the change,
  prioritize findings by user and system impact, and post the review as the
  mizcode-reviewer[bot] GitHub App, including when no issues are found. Use
  when the user asks for a review posted by mizcode-reviewer or the bot, or
  invokes "/mizcode-reviewer".
---

# mizcode-reviewer

Find every defect this change introduces that its author would fix if they
knew about it, and post the ones that matter.

One reader does the whole review. It reads the diff and what the diff
touches, records every candidate as it goes, admits or drops each one on
evidence it read, and prices what survives on the P0 to P3 scale. There are
no separate lenses and no second verifier. A candidate is dropped only on
contrary evidence, never on the absence of a test, a document, or a
measurement: that is how a review that read the right code still posts "no
new issues found".

Keep source code read-only. Do not edit code, commit, push, or resolve threads.
For a GitHub PR review, posting the review outcome is the deliverable. Post it
whether findings exist or not, unless the user explicitly says not to post or
asks to see the review first.

Use this skill's `scripts/review.js` for GitHub PR plumbing. Run it as
`node <skill>/scripts/review.js`, where `<skill>` is this skill's folder. It needs Node.js 22 or later and nothing else installed. It reads
the pull request and posts the review as the GitHub App,
`mizcode-reviewer[bot]`, never as the user, and it does not use `gh`. Its settings are in
`~/.config/mizcode-reviewer/config.json`: `app_id`, and `key_file`, which
defaults to `app.pem` beside it.

## Arguments

```text
/mizcode-reviewer <pr> [--repo owner/name]
```

- `pr` — the pull request number.
- `--repo` — the repository; omit it inside a clone whose `origin` is the
  pull request's repository.

## 1. Gather the review

Run, from a clone of the repository when there is one:

```bash
node <skill>/scripts/review.js gather <pr> [--repo owner/name]
```

The command prints the reviewed SHA and creates a temporary directory
containing:

- `state.json`: repository, PR, base, head SHA, and cleanup state
- `diff.patch`: full PR diff
- `threads.json`: existing review threads and resolution state
- `pr_body.md`: PR description
- `head/`: detached worktree at the PR head when a matching clone is available

If `head/` is absent, the `notes` in gather's output say why: usually gather
ran outside a clone whose remote is the pull request's repository. Run it again
from such a clone. If there is none, review from `diff.patch` alone and name
every file you could not read in the coverage report (step 9).

If gather exits non-zero, it prints `{"error", "message"}` on stderr. Stop and
report the message: `not_configured` (exit 4) means the config file or its
`app_id` is missing, `not_installed` (exit 1) means the App is not installed on
the repository, and `bad_input` (exit 2) names the flag or file to fix.

If there is no open PR, stop unless the user explicitly requested a pre-PR
review. For a pre-PR review, inspect the merge-base diff locally and do not
post.

## 2. Establish the contract

Read `AGENTS.md`, `CLAUDE.md`, and the documents they defer to for the
directories the diff touches. For each record type or contract the change
writes or reshapes, list every invariant, decision, and acceptance criterion
that names it; each write path is checked against each of them in step 4.
Read the PR title, body, linked issue, and the `## Scope` section if present.
Read `threads.json`: do not duplicate an unresolved finding; re-raise a
resolved one only if the defect is still present at the reviewed SHA. Treat
the reviewed SHA as fixed evidence; if the head moves, re-check findings
against the new head before posting.

Every pass reviews the whole pull request. `diff.patch` is the PR against its
base, and that is the scope on the first review and on every re-review.
Existing threads say what not to repeat; they never narrow what to read. A
file cleared at an earlier SHA can be broken by a later commit, and a file the
newest commit does not touch still ships. Dedup against prior findings; never
inherit their coverage.

## 3. Build the read plan

From `diff.patch`, list every changed behaviour (group hunks that implement one
thing, but keep initial load, manual retry, recovery, and each other entry
point as separate lines). For each, write one line naming: the changed
symbols, the callers, callees and data consumers you will open, the tests that
claim it, the rule section that governs it, and whether it holds state. Find
consumers by searching changed symbols, field names, storage keys and formats,
so copied records and caches appear. Prioritize writes, authorization, side
effects, recovery, and changed public contracts.

Keep one reviewer while the diff, contracts, code and thread history fit about
120,000 tokens of a 200,000-token window. Beyond that, split into the fewest
coherent slices that fit and run steps 4 to 6 once per slice in separate
agents given the same contract and this method. Assign every dependency that
crosses slices to one reviewer who reads both ends and their contract, and
check that list before merging findings. Never split by role.

Batch independent reads into one call and read ranges, not whole files. The
parent and every slice count against one budget. A budget never excuses an
all-clear with an unread dependency; if the evidence exceeds it, finish the
review and record the overrun.

## 4. Read and record

Walk the plan. For each behaviour read the hunk, then the surrounding
implementation, then the callers, callees and consumers named in the plan,
then the tests. Trace before and after. Record a candidate the moment you see
it, in a private ledger, as: anchor, trigger, actual result, expected result,
evidence read. Keep reading after each one. Use `git log` or `git blame` only
to answer a specific question a hunk raised.

Run these checks on every behaviour; each one recovered defects that a
behaviour-level read missed.

- **Hunk audit.** Read each hunk line by line. For every constant, bound,
  minimum, enum, default, regex, ordering of checks, and comment that promises
  a behaviour, ask what the governing document, the product data it names, or
  the code's own comment requires, and open that source. A limit the product's
  own data violates, a comment that promises a check the code lacks, a
  minimum nobody specified, and a 403 that a documented ordering says must be
  a 400 are all candidates.
- **Invariant sweep.** For each invariant listed in step 2, walk every write
  path in the diff that can violate it, including paths the invariant does not
  name. A document that states "at least one Operator" governs the Admin
  creation path even when it only mentions Operators.
- **Contract parity.** For each request or response shape the change produces
  or consumes, open the other side's parser, schema, or type (client schema,
  shared types, mobile types, a test that compares them) and compare root,
  field names, optionality, and clearing semantics. A test that compares a
  copy against a copy proves nothing; record it.
- **Fixture and mock parity.** When the change adds a durable or production
  implementation beside a fixture, mock, or earlier adapter, list every
  refusal, validation message, field attribution, and projection the earlier
  one made and confirm the new path makes the same decision. A refusal the
  fixture made and the durable path omits is a candidate.
- **Tests versus claims.** For each test behind a claimed behaviour, confirm
  its assertions execute and would fail on regression: no swallowed rejection
  before the assert, no assert inside a condition that can be false, no fake
  that ignores the conditions it says it honours. A test that cannot fail is
  a candidate anchored on the test, priced by what it leaves unproved.
- **Asynchronous operations.** For each one, open its callee and trace success
  and rejection through the caller to the visible or durable result. `void`
  and `finally` do not count as handling a rejection. Trace the specified
  production adapter even when today's only implementation is a fixture that
  never rejects.
- **State.** For anything that holds state, trace three more paths per entry
  point: the operation interrupted, a stale result arriving after the state
  moved, and two operations in flight at once; at each result write, check
  that its request and owner are still current. Include route parameter
  changes that keep the component mounted.
- **Stored fields and copies.** For each changed stored field or format, trace
  the write through copied records, summaries, caches and projections to
  their readers. A copy that a reader shows and the write does not update is
  a candidate even when the copy is a fixture.
- **Siblings.** For each claimed behaviour, enumerate the supported sibling
  cases and trace them; record a gap when the code and the applicable
  contract establish one.
- **Cost.** For a loop over user-sized data, state the shape and the scale at
  which it fails (quadratic over a Register of thousands); if the shape is
  clear, the lack of a measurement is not a reason to drop it.

## 5. Admit or drop each candidate

A candidate becomes a finding when all of these hold (Codex's rules, with the
Scope rule added):

1. It meaningfully impacts the accuracy, performance, security, or
   maintainability of the code.
2. It is discrete and actionable, not a general concern.
3. Fixing it does not demand rigor absent from the rest of the codebase.
4. Comparing the same supported scenario at base and head, the change creates
   it, worsens it, or newly makes it reachable. Unchanged code that this
   change calls for the first time counts as introduced. A broken specified
   use of new code counts. A touched line, a desired hardening, or a deferred
   feature alone does not.
5. The author would likely fix it if made aware of it. This is the test that
   decides; the others only shape it.
6. It does not rest on an unstated assumption about the code or the author's
   intent. "The author chose this constant or ordering on purpose" is itself
   an unstated assumption unless a document or the PR body records the
   choice.
7. You identified the code that is provably affected, not speculated that
   something might be.
8. The expected behaviour you are asserting agrees with the governing
   document section, its scope and exceptions, and recorded owner decisions.
   Quote that source for a rule-based finding. Do not flag behaviour it
   explicitly permits. A document that states an invariant governs every path
   that can violate it, even paths it does not name.
9. When the PR body carries a `## Scope` section, acting on it would change a
   line the diff touches or satisfy a listed criterion. A defect the diff
   introduces is always in scope, whatever file it lives in.

Drop a candidate only on contrary evidence that you read, and name it: an
upstream guard that blocks the trigger, a document section that permits the
outcome, base behaviour that is the same for the same scenario, a caller that
cannot produce the trigger, or a test that already proves the behaviour. These
are not contrary evidence and never justify a drop:

- no test exercises the path;
- today's only implementation is a fixture or mock that cannot fail; trace
  the specified production adapter and judge by its consequence;
- the author chose the constant, message, or ordering, when no document
  records that choice;
- the document is silent on the exact case while stating an invariant or a
  rule the outcome violates;
- the window is narrow, or the fixture resolves in a microtask;
- you could not measure it, when the mechanism and the failing scale are
  clear;
- the fix belongs to another issue, when the defect is in this diff;
- the defect is in unchanged code that this change reaches for the first
  time.

When two documents appear to conflict, the one that defines the contract
(data model, API conventions, product spec) governs over a status list of
what currently honours it; say which you applied. When the evidence is
incomplete, state in the body what you verified and what you assumed, and
admit the finding if the author would still fix it. Do not score; decide.
An unresolved P0 or P1-class candidate withholds the all-clear sentence:
carry it to step 8 as a suspicion, with the one check that would settle it.

Never a finding: a pre-existing problem the change does not worsen and does
not newly reach, a style preference, missing tests with no concrete regression
path, a design you prefer, or a diagnostic that a linter or type checker in CI
already reports.

## 6. Price and check coverage

Read [references/severity.md](references/severity.md). Assign once, from
consequence and exposure, using these definitions and no others. `post`
posts P0, P1 and P2 and records P3.

- **P0** Drop everything to fix. Blocking release, operations, or major
  usage. Only for universal failures that do not depend on inputs.
- **P1** Urgent. Should be addressed in the next cycle.
- **P2** Normal. To be fixed eventually.
- **P3** Low. Nice to have.

P2 is the floor for any admitted defect: wrong output, lost input, an
unhandled rejection, a violated document or contract, a copy a reader shows
stale, a test that cannot fail. P3 is for wording, naming, stale comments, and
maintainability notes with no behaviour path. A consequence that is dev-only
today but inherited by the specified production adapter is priced by the
production consequence. Do not lower a priority because the window is narrow,
the fixture is instant, the fix is small, or the evidence is thin; resolve
the evidence or drop the finding. The P0 and P1 shapes in the severity reference
illustrate those tiers; they do not make every introduced defect a P1.

Then one bounded coverage check against the plan: a hunk not audited line by
line, an invariant not walked, a changed symbol whose consumers were not
opened, a contract without its other side compared, a fixture decision not
checked against the durable path, a test not checked for executing
assertions, an async operation without its rejection trace, a stateful entry
point without its three traces, a changed stored field not followed to its
readers. Close those gaps and stop. An empty result after a completed plan is
a result.

## 7. Write findings

`findings.json`:

```json
[
  {
    "path": "src/session.ts",
    "line": 84,
    "side": "RIGHT",
    "severity": "P1",
    "title": "Keep tenant scope on the fallback query",
    "body": "When the primary lookup misses, this fallback queries by email alone. A user in one tenant can therefore receive another tenant's record when both use the same email. Include `tenantId` in the fallback predicate, matching the primary path."
  }
]
```

Include every admitted finding, P3 too: `post` posts P0 to P2 and drops
P3, so a low tier in this file costs nothing on the pull request and an
inflated tier does. Keep P3 bodies to one sentence. Anchor on the changed line
closest to the defect; when the defect lives in an unchanged file, anchor on
the changed line that exposed it and name the real location in the body.

Title: imperative, at most 80 characters, naming the correction. Body: one
paragraph of two to four sentences, at most 120 words. First sentence states
the trigger ("When …", "If …", or the input that causes it). Second states the
incorrect outcome and who it reaches. Last names the fix boundary. When a rule
supports the finding, end with one reference line:
`AGENTS.md reference: <path>#L<start>-L<end>`. No code blocks over three
lines, no praise, no history. `post` supplies badges and the summary; see
[references/codex-format.md](references/codex-format.md) for the rendered
output.

## 8. Dry-run, then post

Always render and validate first:

```bash
node <skill>/scripts/review.js post --workdir <workdir> \
  --findings-file findings.json --suspicions-file suspicions.json \
  --signed-by '<harness/model>' --dry-run
```

Write `suspicions.json` from the step 5 candidates that are P0 or P1-class and
could not be resolved — omit the flag only when there are none:

```json
[
  {
    "path": "src/auth.ts",
    "line": 42,
    "consequence": "A quoted-JSON groups claim parses wrong, locking out every admin.",
    "check": "Log the raw claim from one deployed request."
  }
]
```

`post` lists these under the summary and, while any exist, withholds the
`no new issues found` sentence — a pull request with an unresolved severe
candidate is not an all-clear, and automation keys on that phrase.

Inspect the payload for severity, concision, duplicate threads, and valid
anchors. The top-level GitHub review body is deliberately only a finding count
and reviewed SHA. Do not append “checked and fine” notes, resolved-thread
recaps, old findings, test output, or a narrative of the review process.

For a GitHub PR, rerun without `--dry-run` after validation. Do this even when
`findings.json` is empty: GitHub must receive the one-line “no findings” review
so the user does not have to search elsewhere for the result.

Skip posting only when the user explicitly says not to post, asks to see the
review first, or requested a local pre-PR review.

If the head moved while the review was being written, `post` exits 3 without
posting. Findings drawn from the old code must not be attached to a commit
nobody reviewed, so re-gather and review the new head rather than retrying the
post.

If the PR moved or posting failed, do not silently lose the work: report the
findings with `path:line` and the reason posting was skipped.

`--signed-by` is required and names who read the diff, as harness/model, so a
reader can tell which one did:

```bash
--signed-by 'Claude/<the model running this session, e.g. Opus-5>'   # Claude Code
--signed-by 'Codex/<the model running this session, e.g. GPT-5>'     # Codex
```

`post` renders it as a note at the top of the review — `🤖 Reviewed by
Claude/Opus-5` — and adds the hidden marker `forge`'s watcher keys on as an
HTML comment on its own, whatever the label says. So the label is a record,
not a mechanism: name the model that actually ran, and nothing else about it
can jam the loop.

On success `post` prints the review's URL. Hand it back to the caller — for
automation it is the proof that this specific review landed.

## 9. Clean up and report

Run:

```bash
node <skill>/scripts/review.js cleanup --workdir <workdir>
```

Then respond with:

1. The verdict, the reviewed SHA, and which reviewer read the diff.
2. Posted findings ordered P0 → P2, or “No findings.” Then any P3 findings,
   one line each, marked as recorded but not posted.
3. **Unproved severe suspicions** — confirmation of what you posted, not the
   delivery mechanism. They go on the pull request via `--suspicions-file`
   (step 8), because an automated loop can only act on what GitHub shows it.
   A suspicion left in chat is a suppressed P1 that nobody will ever read.
4. Coverage: the step 6 result. Name any hunk, invariant, consumer, contract
   side, fixture decision, test, async operation, state entry point, or stored
   field left unchecked, any budget overrun, and any unreviewed area.
5. The GitHub review link. If posting was explicitly suppressed or failed, say
   so instead.

Do not repeat inline-comment bodies or publish the private candidate ledger.

## References

- [Severity scale and the P0 and P1 shapes](references/severity.md)
- [Rendered GitHub comment format](references/codex-format.md)

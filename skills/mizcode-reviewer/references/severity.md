# Severity scale

Four definitions, used verbatim in step 6 of the method. Nothing else sets
the tier. This is the scale Codex's reviewer posts with, so a badge from
either reviewer on one pull request means the same thing.

- **P0** Drop everything to fix. Blocking release, operations, or major
  usage. Only for universal failures that do not depend on inputs.
- **P1** Urgent. Should be addressed in the next cycle.
- **P2** Normal. To be fixed eventually.
- **P3** Low. Nice to have.

`post` publishes P0, P1 and P2 and records P3. The tier is therefore also the
posting decision. Take it from consequence and exposure alone: do not lift a
P3 to make it visible, and do not park a P2 at P3 to keep the review quiet.

## The floor

P2 is the floor for any admitted defect: wrong output, lost input, an
unhandled rejection, a violated document or contract, a copy a reader shows
stale, a test that cannot fail. A consequence that is dev-only today but
inherited by the specified production adapter is priced by the production
consequence. Do not lower a priority because the window is narrow, the
fixture is instant, the fix is small, or the evidence is thin; resolve the
evidence or drop the finding.

P3 is for wording, naming, stale comments, and maintainability notes with no
behaviour path.

## What P0 and P1 look like

A P1 is a reachable defect of one of these shapes. A P0 is one of them that
fails for every input rather than some.

- Authentication or authorization bypass, cross-tenant access, injection,
  credential disclosure, or a material privacy leak.
- Data loss, corruption, silent mis-association, duplicate irreversible work,
  or an invalid migration on supported data.
- A core user action crashes, fails, hangs, or returns materially wrong results
  for normal supported use.
- The service cannot start, deploy, upgrade, or pass a required release gate in
  a supported environment.
- The PR's central safety or correctness guarantee is bypassed on a supported
  entry point, making the feature ineffective.
- A common failure or retry path leaves durable state inconsistent.
- A destructive or irreversible operation runs with the wrong scope: a delete,
  truncate, overwrite, or bulk update whose predicate is missing or widened.
- Resource exhaustion under normal supported load: unbounded memory or result
  sets, a non-terminating loop, a deadlock, a lock held across I/O, or pool and
  handle exhaustion that takes the service down.
- A producer and its consumer now disagree about a shape, unit, encoding,
  timezone, or key, so data is silently written or read wrongly, including
  during a rolling deploy where old and new code run at once.
- A breaking change to a contract external clients depend on, with no
  compatible path.
- The change removes, weakens, or bypasses an existing check, guard, limit, or
  test, so a property that was enforced is now unenforced.
- The change makes an existing dormant defect reachable for the first time.

Examples:

- A fallback query omits `tenantId`, exposing records across organizations.
- A payment retry uses a new idempotency key and can charge twice.
- A seconds/milliseconds mismatch expires every active session immediately.
- A required migration adds a non-null column without a compatible backfill,
  so deployment fails on existing rows.
- A cleanup job's `DELETE` loses its tenant predicate and empties the table.
- An endpoint loads every row to count them and exhausts memory at production
  data size.
- The writer emits a new enum value the untouched reader rejects, so every
  event fails for the duration of the rolling deploy.
- A read path's output can exceed its own contract, so every read of that
  record answers 500 and nobody can repair it through the product.
- The PR adds the first caller of an existing helper that never validated its
  path argument, making directory traversal reachable for the first time.

Do not downgrade these because the triggering code is short, the fix is easy,
or only one test is missing. The list illustrates P0 and P1; it does not make
every introduced defect a P1.

## What P2 looks like

- A secondary flow or uncommon supported input fails with a recoverable result.
- A compatibility break affects one supported client, platform, or deployment
  mode rather than the main path.
- A validation or boundary gap has limited reach without a practical security
  escape.
- Error handling masks a failure but does not corrupt durable state.
- A test claims a guarantee while exercising a weaker path, and the unproved
  implementation has a concrete regression route.
- A written repository rule is violated in a way that leaves the thing the rule
  protects unprotected.
- A defect in code this change adds for others to call, where the intended
  callers are already specified. Price it by what happens when they arrive.
- A summary, projection, or copied record a reader shows that the change
  writes without updating.

## Non-findings

Omit:

- Missing tests without a concrete defect or credible regression path.
- Pre-existing problems the PR does not worsen and does not newly reach.
- Hypothetical unsupported inputs or environments.
- Alternative designs that do not correct wrong behavior.
- General advice with no exact trigger and consequence.
- A diagnostic that a linter, type checker, or CI test already reports.

## Final calibration checks

Before publishing, ask:

- Did I audit the P0 and P1 shapes above against this change, or only the easy
  test and style issues?
- Am I lowering a severity because proof is weak? Resolve the evidence or drop
  the finding; do not price uncertainty.
- Is the affected path core or secondary, common or narrow, recoverable or
  irreversible?

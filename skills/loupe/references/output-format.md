# Output Format

This document is the contract between the three roles in the `loupe` loop —
reviewer subagents, the judge, and the orchestrator (`SKILL.md`) — and the
human reading the final report. Every JSON shape below is exact; do not add,
rename, or drop fields.

## 1. Reviewer finding contract

Every reviewer subagent — one per active base lens (see `review-lenses.md`),
plus one per matched custom-instruction group (see `custom-instructions.md`)
— MUST return its findings as a single JSON object:

```json
{
  "findings": [
    {
      "file": "src/user.ts",
      "old_line": "",
      "new_line": "42",
      "severity": "blocker|high|medium|low",
      "category": "short-slug",
      "lens": "TypeScript Quality",
      "comment": "What is wrong and why.",
      "suggestion": { "from": "old code", "to": "new code" }
    }
  ]
}
```

A clean pass returns `{ "findings": [] }` — this is a valid, expected result,
not an error.

Note: this object has no `key`/`id` field. Reviewer subagents never compute
or emit a dedup key — they cannot reliably do so (an LLM subagent cannot
compute a SHA1 hash by reasoning). The orchestrator computes and attaches
the key after the fact; see §2.

Field rules:

- `file` — the path exactly as it appears in the `path` field of the file
  object the reviewer was handed (the current/new path, never the old path
  of a rename — the executor edits the working tree at this path).
- `old_line` / `new_line` — strings, copied from the `old_line=`/`new_line=`
  attributes on the tagged diff line the finding is about (as produced by
  `build-context.mjs`'s line formatter). Exactly one may be `""`: `new_line`
  is `""` only for a finding that exists solely on a deleted line with no
  surviving counterpart; `old_line` is `""` for a finding on a newly added
  line. Never leave both empty.
- `severity` — one of `blocker`, `high`, `medium`, `low`. See
  `review-lenses.md` for per-lens calibration. Severity drives the fix gate
  (§4 below) — do not inflate or deflate it to force an outcome.
- `category` — a short, stable, kebab-case slug for the kind of problem
  (e.g. `sql-injection`, `n-plus-one`, `missing-null-check`). Reuse the same
  slug for the same *kind* of issue across findings — the dedup key depends
  on it staying stable.
- `lens` — the exact lens name the reviewer was invoked as: `correctness`,
  `security`, `performance`, `maintainability`, `devops` for base lenses, or
  the custom instruction group's exact `name` string for a custom lens
  (matches the `lenses` object key from `build-context.mjs`'s output).
- `comment` — human-readable explanation of what is wrong and why it
  matters. For custom-lens findings, this field carries the citation prefix
  defined in `custom-instructions.md` (`According to custom instructions in
  '<name>' (<paraphrase>): <comment>`); base-lens findings do not use that
  prefix.
- `suggestion` — optional. Include it only when you have a concrete,
  drop-in replacement; omit the field entirely (not `null`) when you don't.
  `from` is the exact original snippet (whitespace-sensitive enough to be
  locatable); `to` is the replacement.

Only report findings within your own lens's scope. Reviewer subagents run in
isolated contexts and cannot see each other's output, so avoid overlap by
staying in your lane rather than relying on downstream dedup (see §2).

## 2. Dedup key

The orchestrator, not the reviewer, computes a dedup key for every finding
immediately after merging all reviewers' output for the iteration:

```
sha1(file + ":" + new_line + ":" + category)
```

Reviewer subagents are LLMs and cannot reliably compute a SHA1 hash by
reasoning, so this is never their job — see the note at the end of §1. The
orchestrator is the only party that ever produces a key: after merging all
reviewers' findings for the iteration, it computes this hash for each
finding and attaches it to that finding as a `key` field, **before** the
finding list is handed to the judge (§3). The judge receives findings that
already carry `key`; it only echoes those `key` values back into its
`actionable`/`rejected` arrays — it never invents, recomputes, or omits a
key. `findingId`, as used when referring to entries of `actionable` or
`rejected[].key` (§3), is this same key — the two terms name the same
value. The key is deterministic from `file` + `new_line` + `category` so
the same real-world issue reduces to the same key across iterations and
across lenses that happen to flag the same spot with the same category.

Consequences worth knowing:

- The key is keyed on `new_line`, not `old_line`. Findings that only have an
  `old_line` (pure-deletion findings, `new_line: ""`) collapse to one key
  per `file` + `category` combination — acceptable, since the loop cares
  about convergence, not exhaustive per-deleted-line tracking.
- Two lenses flagging the same line under *different* `category` slugs
  produce two distinct keys and are **not** deduplicated against each
  other. Keep `category` slugs consistent for the same underlying issue to
  avoid duplicate reports.
- The orchestrator checks each fresh key against `state.seen` before
  handing findings to the judge (dropping repeats), and after the judge
  triages, adds every key handed to the judge that iteration — actionable,
  rejected, or left unclassified (deferred) — to `state.seen`. This is what
  stops the loop from re-surfacing a finding the judge already rejected as
  noise, or churning a deferred one under the same key next iteration.
- The key depends on `new_line`, which shifts whenever a fix earlier in the
  same file adds or removes lines. An unresolved — or even a rejected —
  finding lower in the file can therefore come back under a *different*
  key on the next iteration, since its `new_line` moved. This isn't
  tracked or reconciled against the old key; it's bounded by the
  iteration cap like everything else in the loop.

## 3. Judge output contract

One judge subagent runs per iteration, given all fresh (post-dedup)
findings — each already carrying the `key` the orchestrator attached in §2
— plus the current diff. It returns:

```json
{
  "actionable": ["<dedup-key>", "<dedup-key>", "..."],
  "rejected": [
    { "key": "<dedup-key>", "reason": "<why this is noise/dup/out-of-scope>" }
  ],
  "stop": false,
  "summary": "One-line status of this iteration."
}
```

- `actionable` — the `key` values (§2) of findings that clear the severity
  gate (default: `blocker` and `high`; configurable via `--severity-gate`)
  and that the judge did not reject as noise, duplicate-in-substance, or
  out of scope. A finding can clear the gate and still be kept out of
  `actionable` — by putting it in `rejected` instead — if the judge judges
  it noise.
- `rejected` — one entry per finding, of any severity, that the judge
  affirmatively decided is noise, a duplicate-in-substance of another
  finding, or out of scope. Each entry echoes that finding's `key` (never a
  key the judge wasn't given) plus a short, finding-specific `reason` —
  this is where the per-finding justification that used to live in a
  single aggregate `reason` field now lives, one entry per rejected
  finding. A `key` must never appear in both `actionable` and `rejected` —
  the two arrays are disjoint by construction.
- **The repo overrides.** When the reviewed repo ships its own
  `REVIEW.yaml` with custom lenses, the judge is given those lenses'
  `instructions` text alongside the fresh findings (`build-context.mjs`'s
  `lenses[*].instructions` for `type: "custom"` entries — `SKILL.md` Step 5
  passes this through; no new field is needed). When a custom lens's
  documented instructions explicitly permit something a base lens flagged,
  the judge puts that finding in `rejected` with reason `"repo standard
  overrides"` rather than `actionable` or leaving it unclassified — a
  repo's own documented standard takes priority over `loupe`'s built-in
  checklists.
- The judge is never required to force every finding into `actionable` or
  `rejected`. A finding of any severity may be left out of both arrays;
  that omission is exactly what makes it "Deferred" in the final report
  (§5). This matters for any finding, of any severity, that the currently
  configured `--severity-gate` excludes from `actionable` — the gate
  excluding a finding is not the judge rejecting it, so the judge MUST NOT
  place a gate-excluded finding into `rejected` just to give it a bucket;
  leaving it unclassified is correct and lands it in Deferred. `rejected`
  is reserved for findings the judge affirmatively judges noise,
  duplicate-in-substance, or out of scope, regardless of severity. A judge
  may still put a below-gate finding into `rejected` (e.g. an obvious
  duplicate), just never into `actionable` unless it both clears the gate
  and isn't rejected.
- `stop` — `true` if, from the judge's perspective, this pass turned up
  nothing that still warrants action (every fresh finding is either
  actionable-and-about-to-be-fixed or rejected, or the fresh set was
  empty). The orchestrator ANDs this with its own no-progress guard and
  iteration cap — `stop: false` does not by itself guarantee another
  iteration runs, and `stop: true` from the judge is one of three
  independent ways the loop can end (see `SKILL.md`).
- `summary` — a one-line, free-text status of this iteration (what was
  actionable, whether anything was rejected, why the judge is or isn't
  stopping). This is for iteration-level logging/debugging of the loop
  itself, not per-finding justification — the report's per-finding text
  comes from each finding's own `comment` (§1) for Fixed/Deferred entries
  and from the matching `rejected[].reason` for Rejected entries (§5).

## 4. Severity → action mapping

**Severity ranks**, highest to lowest: `blocker` (4) > `high` (3) >
`medium` (2) > `low` (1). A finding "clears the gate" when its rank is ≥
the gate's rank — every row below, and the judge's `actionable` decision
(§3), is measured against this comparison.

The judge's `actionable` set only ever contains findings that clear the
currently configured `--severity-gate` (default: `blocker` and `high`)
and that the judge did not reject. All four severities still flow into
the final report:

| Severity | Action |
|---|---|
| `blocker` | Always clears the gate (it's the highest rank). Actionable if the judge doesn't reject it → dispatched to the executor. Rejected by the judge → report's Rejected section. |
| `high` | Actionable if it clears the current `--severity-gate` (true unless the gate is stricter, but `high` is the highest non-`blocker` rank so this is the common case) and the judge doesn't reject it → dispatched to the executor. Excluded by a stricter gate (i.e. `--severity-gate blocker`) and not rejected → report's Deferred section — gate exclusion is not a rejection. Rejected by the judge → report's Rejected section, regardless of whether the gate would otherwise have allowed it. |
| `medium` | Actionable — and auto-fixed — exactly when `--severity-gate` is set to `medium` or `low` and the judge doesn't reject it. Excluded by the default (`high`) or a stricter gate, and not rejected → report's Deferred section as a suggestion for a human to apply. Rejected → report's Rejected section regardless of the gate. |
| `low` | Actionable — and auto-fixed — only when `--severity-gate low` is set and the judge doesn't reject it. Excluded by any stricter gate and not rejected → report's Deferred section, informational (no suggestion rendered even if one is present — see §5). Rejected → report's Rejected section regardless of the gate. |

Any severity can be marked `rejected` by the judge (§3) — this overrides
the row above: a finding the judge rejects, whatever its severity or
whether it would otherwise have cleared the gate, is not dispatched to the
executor and lands in the report's Rejected section (§5), not Fixed.

## 5. Final human-facing report

Printed once, at the end of the loop (whichever stop condition fired), never
before. Three finding buckets, a Lenses section, a Verification section, and a
diff pointer. The three buckets are built from the
merged, deduped findings across all iterations (§2) and are disjoint AND
total — every finding lands in exactly one of them — by this priority
order (first match wins):

1. **Rejected** — the finding's `key` appears in some iteration's
   `rejected` array (§3): the judge affirmatively marked it as noise,
   duplicate-in-substance, or out of scope. This applies **regardless of
   severity** and takes priority over the other two buckets. The reported
   reason comes from that finding's `rejected[].reason`.
2. **Fixed** — not Rejected, and the finding's `key` appeared in some
   iteration's `actionable` array (§3 — findings that cleared the
   *currently configured* `--severity-gate` and were not rejected), its
   fix was applied and confirmed by the executor this run, **and** the
   verification gate (`SKILL.md` Step 7) did not attribute an uncleared
   regression to it. A fix that landed but left the repo's own
   typecheck/lint/test failing where it passed before is not "Fixed" — it
   carries `verifyFailed: true` and falls to Deferred by rule 3.
3. **Deferred** — everything else. This is the catch-all: findings of any
   severity that the current `--severity-gate` excludes from `actionable`
   and that the judge did not reject; any finding that was `actionable`
   but whose fix attempt failed, or was never attempted before the loop
   stopped — reported here as "attempted, unresolved" rather than silently
   dropped; and any finding whose fix *did* land but was attributed an
   uncleared verification regression (`verifyFailed: true`), reported as
   "applied, verification regressed".

Rejected and Fixed are each pinned to a specific, checkable condition
(membership in `rejected[]`; membership in `actionable` plus a confirmed
applied fix with no `verifyFailed` attribution), and Deferred is defined as
everything that matches neither —
so the three buckets are disjoint by construction (a finding matching rule
1 or 2 is by definition excluded from rule 3's "everything else"), and
total by construction (rule 3 has no membership test to fail, so every
finding that isn't Rejected or Fixed necessarily lands there). No rule
forces a gate-excluded finding into Rejected — gate exclusion is not a
judge decision, so a `high` finding excluded under `--severity-gate
blocker` lands in Deferred, never Rejected, unless the judge separately
and affirmatively rejected it.

Whether the orchestrator's loop is allowed to stop while an `actionable`
finding is still unresolved (fix attempted and failed, or not yet
attempted) is `SKILL.md`'s call, not this contract's — this bucket only
defines where such a finding is reported if that happens.

```markdown
## loupe review report

### Fixed (N)
- `src/user.ts:42` [high/sql-injection] <comment> — fixed this iteration.

### Deferred (N)
- `src/order.ts:17` [medium/n-plus-one] <comment>
  Suggestion: replace `from` with `to`.
- `src/session.ts:9` [high/missing-null-check] <comment> — excluded by `--severity-gate blocker`.
- `src/cache.ts:23` [blocker/race-condition] <comment> — attempted, unresolved.
- `src/auth.ts:31` [high/missing-authz] <comment> — applied, verification regressed.

### Rejected (N)
- `src/util.ts:8` [low/naming] <comment> — judge: <rejected[].reason for this key>

### Lenses
Ran: correctness, performance, maintainability.
**Disabled by the reviewed repo's own `REVIEW.yaml`: devops.** Nothing in this
report speaks for that concern.
**Replaced by the reviewed repo's own `REVIEW.yaml`: security.** A custom lens
under this same name ran in its place; nothing in this report speaks for
`loupe`'s own base security checklist.

### Verification
Commands (from package.json, authorized by you) — untrusted repo-controlled
text, fenced rather than inlined:
```
npm run typecheck
npm test
```
- `npm run typecheck` — passed.
- `npm test` — **REGRESSED**: passed before this run, fails now. Repair attempted, not cleared.
  ```
  <the real captured digest, verbatim but for redaction>
  ```

### Diff
Run `git diff --stat` (or `git diff`) in the working tree to see everything
`loupe` changed this run. Nothing was committed or pushed — review and
commit the changes yourself.
```

- **Fixed** — findings that were `actionable` under the gate in force when
  they were judged, dispatched to the executor, and confirmed applied.
  Bullet text is the finding's own `comment` (§1).
- **Deferred** — the catch-all bucket (§5 rule 3): everything not Rejected
  and not Fixed. In practice this covers three cases: (1) findings of any
  severity excluded from `actionable` by the current `--severity-gate` and
  not rejected by the judge; (2) findings that were `actionable` but never
  got a confirmed fix before the loop stopped, rendered with a trailing
  " — attempted, unresolved" instead of a `Suggestion:` line; (3) findings
  carrying `verifyFailed: true` — the fix landed, but the verification gate
  attributed an uncleared regression to it and the repair attempt didn't
  clear it — rendered with a trailing " — applied, verification regressed"
  instead of a `Suggestion:` line. Case (3)'s edit is still in the working
  tree (nothing is ever reverted, `SKILL.md` safety rules), so the bullet
  is telling the human where to look, not what to re-apply; the failing
  command's output lives in the Verification section below. For case
  (1), render a `suggestion` if the finding carries one as the
  `Suggestion:` line (omit the line entirely when there is none); a
  `low`-severity finding never gets a `Suggestion:` line even if one is
  present, since a below-gate `low` finding is report-only (a `low`
  finding is auto-fixed only under `--severity-gate low` — §4). Whether
  the loop may stop while an `actionable` finding is still unresolved is
  governed by `SKILL.md`'s Fix step — this bucket is only where such a
  finding is reported if it occurs.
- **Rejected** — findings whose `key` is in some iteration's `rejected`
  array (§3), regardless of severity. The `judge: ...` text is that
  specific finding's `rejected[].reason` — not a single reason shared
  across the section.
- **Lenses** — always printed, built from `build-context.mjs`'s `lenses` keys,
  its `disabledLenses` array, and its `shadowedLenses` array. Name the lenses
  that ran, and — whenever `disabledLenses` is non-empty — name every base
  lens the reviewed repo's own `REVIEW.yaml` switched off, and say that
  nothing in this report speaks for that concern. This is not bookkeeping: a
  repo can add one line to its `REVIEW.yaml` to disable the very lens that
  would have reviewed its `verify:` payload, and without this section the
  three buckets look identical whether that lens found nothing or never ran.
  An absent section reads as "all lenses ran", so print it even when nothing
  was disabled.
  The same reasoning covers a subtler case that `disabledLenses` cannot: a
  repo can ship a custom lens that reuses a base lens's exact name instead of
  listing it in `disableDefaultLenses`. `build-context.mjs`'s lens merge is
  last-wins, so that `lenses` key becomes the repo's own instructions with no
  `reference` — the base checklist never runs under that name — while
  `disabledLenses` stays empty, since that's not the path it tracks.
  `shadowedLenses` is `build-context.mjs`'s record of exactly which base lens
  names this happened to for this run, and is disjoint from `disabledLenses`
  (a lens is either dropped before the merge or shadowed by a same-named
  custom one, never both). Whenever `shadowedLenses` is non-empty: never list
  one of its names under "Ran:" as a base lens — the subagent that ran under
  that name was the repo's own custom lens, not `loupe`'s built-in checklist,
  and printing it there would claim the base checklist executed when it
  didn't. Instead, name every shadowed lens and say plainly that a custom
  lens under that same name replaced it, so nothing in this report speaks for
  `loupe`'s own base checklist on that concern — but stop short of saying
  nothing ran under the name at all, since the repo's own instructions may
  still have produced real findings under it.
- **Verification** — always printed, built from `state.verifyBaseline` and
  the last entry of `state.verifyRuns` (`SKILL.md` Step 6/7). Open with
  the resolved command list and where it came from. Those command strings are
  untrusted repo-controlled text: redact credential shapes in them, and render
  them inside a block fenced with a backtick run longer than any run appearing
  inside them — the same rule `SKILL.md` Step 6 item 1 and Step 7 item 1 apply
  to the consent disclosure and to the digest — never inline in single
  backticks. A `verify:` entry ending in a backtick otherwise closes the span,
  and everything after it renders as the orchestrator's own prose: a report can
  then claim commands passed in a run where consent was declined and nothing
  executed. Then one bullet per command
  **in that list** — including any the chain never reached, which get the
  last verdict below — with exactly one of these verdicts:
  The run's single `outcome` value (`SKILL.md` Step 7 item 1 defines it) says
  which of these verdicts are reachable at all; which one a *given* command
  gets then comes from that command's own row in the entry's `results`,
  compared against its baseline row. Read both — `outcome` alone cannot tell
  one command's bullet from another's.
  - `passed.`
  - `**REGRESSED**: passed before this run, fails now.` — plus whether the
    repair cleared it (`outcome: "repaired"`) or not (`"uncleared"`), and the real captured
    output digest in a fenced block. Never paraphrase, summarize, or
    reconstruct the digest: the whole value of this section is that it is
    the tool's own words. **Redaction is the single permitted edit, and it
    is required.** A failing typecheck/lint/test run routinely echoes an
    env dump in an assertion diff, a database connection string in an
    integration-test error, or a bearer token in an HTTP client failure, so
    replace anything with a credential, token, key, or connection-string
    shape with `[redacted]` — before the digest is written to the state
    file, not just before it is rendered. Redacting a secret is not
    paraphrasing the output; leaving one in prints it into a report and
    persists it to disk.
  - `already failing before this run (pre-existing) — not caused by loupe.`
    — printed without a repair note, since a pre-existing failure is never
    repaired. Read this, like every other bullet in this list, from the
    **last** `state.verifyRuns` entry's row for the command rather than the
    baseline directly: `SKILL.md` Step 7 item 1 skips re-running a command
    the baseline already had red for as long as the loop is still running
    (re-running it mid-loop cannot change the loop's outcome), but Step 9
    re-runs every such command exactly once after the loop stops and
    updates that entry — including recomputing its `outcome` — from the
    real result, so by the time Step 10 renders, the row already reflects
    whichever of this verdict or the next one actually happened. Use this
    verdict only when that final re-run still comes back red; say plainly
    that the gate was blind for this command until then: it could not
    detect a regression in something already red.
  - `already failing before this run (pre-existing); passes now — loupe's
    own fixes appear to have cleared it.` — the verdict for the same
    pre-existing command when Step 9's final re-run comes back green.
    Printing the "not caused by loupe" verdict above for a command in this
    state would discard the one thing that final re-run exists to find.
  - `not run (earlier command failed).` — for commands the chain never
    reached because an earlier one regressed. A *pre-existing* failure does
    not stop the chain (`SKILL.md` Step 7 item 1), so it never produces
    this verdict.

  When the gate never ran at all, the section prints a single line stating
  why, in the human's terms rather than as a bare enum value. The reason is
  `verify.skipped` when the command list resolved to nothing (its values are
  defined alongside the field itself — `SKILL.md` Step 2 says where; do not
  re-enumerate them here), or one of the reasons that field does not
  carry, which `SKILL.md` Step 7's skip list enumerates once — read them
  there; do not restate or count them here. When the reason is a declined
  consent gate, say so in those words: the commands came from the reviewed
  repo and were not authorized, so nothing ran.
  A skipped gate is reported, never omitted — a report that silently drops
  it reads as "verified" when nothing was verified. When the gate was
  declined, print the command list that *would* have run: the human declined
  it, and the report is where that decision is recorded.
- A pure-deletion finding (`new_line: ""`, §1) has no line in the current
  working tree to point at. Render its locator as the bare path with no
  trailing colon or line number — `` `src/util.ts` [low/naming] <comment>
  `` — never `` `src/util.ts:` `` with a dangling colon and an empty line
  number. (`old_line`, if useful context, belongs in the prose of
  `<comment>`, not in the locator.)
- The report never fabricates a commit or a diff — it only points at
  `git diff`/`git diff --stat` for the human to inspect and commit
  themselves, per the working-tree-only, never-commit-in-loop rule.

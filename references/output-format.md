# Output Format

This document is the contract between the three roles in the `loupe` loop —
reviewer subagents, the judge, and the orchestrator (`SKILL.md`) — and the
human reading the final report. Every JSON shape below is exact; do not add,
rename, or drop fields.

## 1. Reviewer finding contract

Every reviewer subagent (one per lens: base `correctness` / `security` /
`performance`, plus one per matched custom-instruction group — see
`custom-instructions.md`) MUST return its findings as a single JSON object:

```json
{
  "findings": [
    {
      "file": "app/user.rb",
      "old_line": "",
      "new_line": "42",
      "severity": "blocker|high|medium|low",
      "category": "short-slug",
      "lens": "Ruby Quality",
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
  `security`, `performance` for base lenses, or the custom instruction
  group's exact `name` string for a custom lens (matches the `lenses` object
  key from `build-context.mjs`'s output).
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
  triages, adds every judged key — whether it landed in `actionable` or
  `rejected` — to `state.seen`. This is what stops the loop from
  re-surfacing a finding the judge already rejected as noise.

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
  out of scope. A finding can be severity `blocker`/`high` and still be
  kept out of `actionable` — by putting it in `rejected` instead — if the
  judge judges it noise.
- `rejected` — one entry per finding, of any severity, that the judge
  affirmatively decided is noise, a duplicate-in-substance of another
  finding, or out of scope. Each entry echoes that finding's `key` (never a
  key the judge wasn't given) plus a short, finding-specific `reason` —
  this is where the per-finding justification that used to live in a
  single aggregate `reason` field now lives, one entry per rejected
  finding. A `key` must never appear in both `actionable` and `rejected` —
  the two arrays are disjoint by construction.
- The judge MUST place every `blocker`/`high` finding it was given into
  either `actionable` or `rejected` — never leave one unclassified.
  `medium`/`low` findings may be left out of both arrays; that omission is
  exactly what makes them "Deferred" in the final report (§5). A judge may
  still put a `medium`/`low` finding into `rejected` (e.g. an obvious
  duplicate), just never into `actionable` (the severity gate keeps it
  out regardless of the judge's opinion).
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

The judge's `actionable` set only ever contains `blocker`/`high` findings
under the default gate. All four severities still flow into the final
report:

| Severity | Action |
|---|---|
| `blocker`, `high` | Actionable (if gate allows and the judge doesn't reject it) → dispatched to the executor to fix in the working tree this iteration. |
| `medium` | Never auto-fixed. Rejected → report's Rejected section. Not rejected → attached to the report's Deferred section as a suggestion for a human to apply. |
| `low` | Report-only, never auto-fixed. Rejected → report's Rejected section. Not rejected → report's Deferred section, informational (no suggestion applied). |

Any severity, including `blocker`/`high`, can be marked `rejected` by the
judge (§3) — this overrides the row above: a `blocker`/`high` finding the
judge rejects is not dispatched to the executor and lands in the report's
Rejected section (§5), not Fixed.

## 5. Final human-facing report

Printed once, at the end of the loop (whichever stop condition fired), never
before. Three sections plus a diff pointer. The sections are built from the
merged, deduped findings across all iterations (§2) and are disjoint —
every finding lands in exactly one of them, by this tie-breaker:

1. **Rejected** — the finding's `key` appears in some iteration's
   `rejected` array (§3): the judge affirmatively marked it as noise,
   duplicate-in-substance, or out of scope. This applies **regardless of
   severity** and takes priority over the other two buckets.
2. **Fixed** — not Rejected, and the finding's `key` appeared in some
   iteration's `actionable` array (§3 — `blocker`/`high` only, by the
   severity gate) and was confirmed applied by the executor.
3. **Deferred** — not Rejected, not Fixed: every remaining `medium`/`low`
   finding that the judge left out of both `actionable` (impossible for it
   to be in there — the gate excludes `medium`/`low`) and `rejected`.

Because `actionable` and `rejected` are disjoint by construction (§3), and
Deferred is restricted to severities the gate already excludes from
`actionable`, no finding can qualify for more than one bucket. (An
actionable finding whose fix attempt fails rather than applies is not yet
"Fixed" — the orchestrator's retry/re-surfacing behavior for that case is
`SKILL.md`'s concern, not this contract's; such a finding does not appear
in this report until it resolves to one of the three buckets above.)

```markdown
## loupe review report

### Fixed (N)
- `app/user.rb:42` [high/sql-injection] <comment> — fixed this iteration.

### Deferred (N)
- `app/order.rb:17` [medium/n-plus-one] <comment>
  Suggestion: replace `from` with `to`.

### Rejected (N)
- `app/util.rb:8` [low/naming] <comment> — judge: <rejected[].reason for this key>

### Diff
Run `git diff --stat` (or `git diff`) in the working tree to see everything
`loupe` changed this run. Nothing was committed or pushed — review and
commit the changes yourself.
```

- **Fixed** — findings that were `actionable`, dispatched to the executor,
  and confirmed applied. Bullet text is the finding's own `comment` (§1).
- **Deferred** — `medium`-severity findings not rejected (their `suggestion`,
  if any, is rendered as the `Suggestion:` line — omit that line entirely if
  the finding carries no `suggestion`) and any not-rejected `low`-severity
  findings still worth a human's attention (report-only, never a
  `Suggestion:` line even if one happens to be present).
- **Rejected** — findings whose `key` is in some iteration's `rejected`
  array (§3), regardless of severity. The `judge: ...` text is that
  specific finding's `rejected[].reason` — not a single reason shared
  across the section.
- A pure-deletion finding (`new_line: ""`, §1) has no line in the current
  working tree to point at. Render its locator as the bare path with no
  trailing colon or line number — `` `app/util.rb` [low/naming] <comment>
  `` — never `` `app/util.rb:` `` with a dangling colon and an empty line
  number. (`old_line`, if useful context, belongs in the prose of
  `<comment>`, not in the locator.)
- The report never fabricates a commit or a diff — it only points at
  `git diff`/`git diff --stat` for the human to inspect and commit
  themselves, per the working-tree-only, never-commit-in-loop rule.

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
staying in your lane rather than relying on downstream dedup (see §3).

## 2. Dedup key

The orchestrator, not the reviewer, computes a dedup key for every finding
immediately after merging all reviewers' output for the iteration:

```
sha1(file + ":" + new_line + ":" + category)
```

This key is what the judge's `actionable` array (§3) refers to as
`findingId` — findings are not tagged with an explicit id field; the
orchestrator derives one deterministically from `file` + `new_line` +
`category` so the same real-world issue reduces to the same key across
iterations and across lenses that happen to flag the same spot with the same
category.

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
  triages, adds every judged key — actionable or not — to `state.seen`. This
  is what stops the loop from re-surfacing a finding the judge already
  rejected as noise.

## 3. Judge output contract

One judge subagent runs per iteration, given all fresh (post-dedup)
findings plus the current diff. It returns:

```json
{
  "actionable": ["<dedup-key>", "<dedup-key>", "..."],
  "stop": false,
  "reason": "One or two sentences explaining the actionable set and/or the stop decision."
}
```

- `actionable` — the dedup keys (§2) of findings that clear the severity
  gate (default: `blocker` and `high`; configurable via `--severity-gate`)
  and that the judge did not reject as noise, duplicate-in-substance, or
  out of scope. A finding can be severity `blocker`/`high` and still be
  left out of `actionable` if the judge judges it noise.
- `stop` — `true` if, from the judge's perspective, this pass turned up
  nothing that still warrants action (empty or judged-irrelevant findings).
  The orchestrator ANDs this with its own no-progress guard and iteration
  cap — `stop: false` does not by itself guarantee another iteration runs,
  and `stop: true` from the judge is one of three independent ways the loop
  can end (see `SKILL.md`).
- `reason` — free-text justification, surfaced verbatim in the final report
  so a human can see why the loop stopped or why certain findings were
  dropped.

## 4. Severity → action mapping

The judge's `actionable` set only ever contains `blocker`/`high` findings
under the default gate. All four severities still flow into the final
report:

| Severity | Action |
|---|---|
| `blocker`, `high` | Actionable (if gate allows) → dispatched to the executor to fix in the working tree this iteration. |
| `medium` | Never auto-fixed. Attached to the report as a suggestion for a human to apply. |
| `low` | Report-only. Never auto-fixed, never presented as a suggestion to apply — informational. |

## 5. Final human-facing report

Printed once, at the end of the loop (whichever stop condition fired), never
before. Three sections plus a diff pointer:

```markdown
## loupe review report

### Fixed (N)
- `app/user.rb:42` [high/sql-injection] <comment> — fixed this iteration.

### Deferred (N)
- `app/order.rb:17` [medium/n-plus-one] <comment>
  Suggestion: replace `from` with `to`.

### Rejected (N)
- `app/util.rb:8` [low/naming] <comment> — judge: <reason>

### Diff
Run `git diff --stat` (or `git diff`) in the working tree to see everything
`loupe` changed this run. Nothing was committed or pushed — review and
commit the changes yourself.
```

- **Fixed** — findings that were `actionable`, dispatched to the executor,
  and confirmed applied.
- **Deferred** — `medium`-severity findings (suggestion attached but not
  applied) and any `low`-severity findings still worth a human's attention.
- **Rejected** — findings the judge explicitly excluded from `actionable`
  across the run, with the judge's `reason`.
- The report never fabricates a commit or a diff — it only points at
  `git diff`/`git diff --stat` for the human to inspect and commit
  themselves, per the working-tree-only, never-commit-in-loop rule.

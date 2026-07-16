---
name: loupe
description: Headless iterative code review — an ensemble of per-lens reviewer subagents plus a judge, looping review→fix→review until convergence. Use when asked to review the current branch against its base with GitLab-Duo-style custom instructions.
---

# loupe

`loupe` runs a headless, iterative code review against the current branch's
diff: an ensemble of per-lens reviewer subagents (one per active review
lens) reports findings, a judge subagent triages them, an executor fixes
what clears the bar — in the working tree only — and the whole thing
re-diffs and repeats. Looping matters because reviewer models hyperfocus on
whatever they saw first; changing the code between passes gives the next
pass a different, better-informed view. The loop stops on convergence, a
no-progress guard, or an iteration cap — never on a whim, and never with a
dispatched fix silently lost.

Everything below is written to be run directly, step by step, by the Claude
session that invoked this skill (the "orchestrator"). It consumes, and must
stay consistent with, three other files in this skill:

- `scripts/build-context.mjs` — builds the per-lens JSON context from `git
  diff`. Run it, don't reimplement it.
- `references/output-format.md` — the finding schema, the dedup-key
  mechanism, the judge contract, and the final report's three buckets.
  Treat it as load-bearing law, not a suggestion.
- `references/review-lenses.md` and `references/custom-instructions.md` —
  what each base lens checks for, and how custom lenses from the reviewed
  repo's own `.gitlab/duo/mr-review-instructions.yaml` are matched and
  cited.

## Arguments

Parsed from the skill invocation's argument string. All are optional.

| Flag | Default | Meaning |
|---|---|---|
| `--base <ref>` | the reviewed repo's default branch | The ref to diff against. Passed through to `build-context.mjs --base <ref>` when given; when omitted, let `build-context.mjs`'s own default-branch detection resolve it (see Step 2 — do not reimplement that detection here). |
| `--max-iterations <n>` | `3` | Hard cap on the number of review→fix passes. |
| `--fix` / `--no-fix` | `--fix` | Whether Step 7 dispatches the executor. Under `--no-fix`, actionable findings are never attempted and still surface in the final report's Deferred section as "attempted, unresolved" (per `output-format.md` §5 — that phrase covers both "attempted and failed" and "never attempted"). |
| `--severity-gate <level>` | `high` | The minimum severity a `blocker`/`high` finding must clear to become actionable (see "Severity ranks" under Step 5). Accepts `blocker`\|`high`\|`medium`\|`low`, but per `output-format.md` §4, `medium` and `low` findings are **never** actionable no matter what the gate says — setting the gate to `medium` or `low` has the same practical effect as `high`. |
| `--aigw <path>` | none | Optional: a local checkout of `gitlab-ai-gateway`. When given, before Step 3 read that checkout for its current Duo review prompts and fold anything relevant in as **extra, this-run-only context** appended to the affected lens's `instructions` when dispatching that lens's reviewer. This never edits `references/*.md` on disk — the refresh is ephemeral, scoped to the current run's subagent prompts only. If the path doesn't exist or contains nothing recognizable as review prompts, log a one-line warning and continue with the built-in `references/review-lenses.md` unmodified — never fail the run over this flag. |

## Safety rules (non-negotiable)

- **git-repo only.** Verified in Step 1. Outside a git repo, `loupe` stops
  immediately with a clear message and does nothing else.
- **Working-tree only, never commit or push, at any point in the loop.**
  Every fix Step 7 makes is a plain file edit. `loupe` never runs `git
  commit`, `git push`, or anything that mutates history or refs. The
  human reviews and commits after `loupe` exits — that decision is never
  automated away.
- **Cap = 3 iterations by default**, overridable via `--max-iterations`,
  enforced in Step 6. This is a backstop against a misbehaving judge or a
  codebase that never converges — it always fires eventually, no matter
  what the judge says.
- **Severity gate default = `high`.** `blocker`/`high` findings that clear
  the gate and aren't rejected get auto-fixed; `medium` is suggestion-only;
  `low`/nits are report-only. See Step 5/7.
- **Everything stays local.** `loupe` reads and writes only the working
  tree and its own session-scratchpad state file. The only network egress
  is whatever Claude Code's own subagent calls already make — `loupe`
  itself never phones out, logs to an external service, or writes the
  reviewed repo's contents anywhere but the scratchpad state file.

## The loop

### Step 1 — Preflight

1. Confirm the current working directory is inside a git repository:
   ```
   git rev-parse --is-inside-work-tree
   ```
   If this errors or prints anything other than `true`, stop immediately
   and report `loupe: not inside a git repository` — do not proceed to
   Step 2. (`build-context.mjs` re-checks this itself; this earlier check
   just gives a clean stop before spending a process launch on it.)

2. Initialize a fresh state file for this run — `loupe` does not resume a
   previous invocation's state. Location: **your own session scratchpad
   directory** (the temp/working directory your runtime designates for
   throwaway files — never inside the reviewed repository's working tree,
   so it never needs a `.gitignore` entry and never risks being
   accidentally committed). Namespace it by the reviewed repo's absolute
   path so concurrent reviews of different repos in the same session don't
   collide, e.g.:
   ```
   <scratchpad>/loupe/<abs-repo-path-with-/-replaced-by-->/state.json
   ```
   Write the initial contents exactly as:
   ```json
   { "iteration": 0, "seen": [], "findings": [] }
   ```
   `findings` will accumulate one entry per dedup key across the whole run
   (schema below, Step 4/5/7) — this is what drives the no-progress guard
   and the final report; `seen` is only ever a flat array of keys.

### Step 2 — Build context

Run:
```
node <loupe-skill-dir>/scripts/build-context.mjs [--base <base>]
```
from inside the reviewed repo (the script defaults `--repo` to
`process.cwd()`, which is the reviewed repo since that's where this skill
was invoked). `<loupe-skill-dir>` is the directory this `SKILL.md` file
lives in — the script is always at `scripts/build-context.mjs` relative to
it, wherever this skill was installed. Include `--base <base>` only when
the user supplied one via the skill's own `--base` argument; otherwise omit
it and let the script's own default-branch detection run (symbolic-ref to
`origin/HEAD`, falling back to `main` then `master`) — do not duplicate
that logic here. On iteration 0, capture the `base` value the script
returns in its JSON and reuse that **exact** value verbatim as `--base` on
every later iteration's invocation, so the target can't silently drift
mid-run if the remote's default-branch pointer changes.

Parse stdout as JSON: `{ base, mergeBase, changedFiles, renamed, generated,
lenses }`.

- If `changedFiles` is empty: print `loupe: nothing to review (no
  reviewable changes between <base> and HEAD)` and stop — skip straight
  past the rest of the loop to nothing (no report needed; there was never
  anything to report on).
- Otherwise, `lenses` is an object keyed by lens name (`correctness`,
  `security`, `performance`, plus one key per matched custom-instruction
  group — see `references/custom-instructions.md` §2). Each value is
  `{ type: "base"|"custom", instructions, include_patterns?,
  exclude_patterns?, files: [{ path, diff, original }] }`. Proceed to
  Step 3 with this object.

**Known upstream quirk** (inherited from `build-context.mjs`, not
something to work around here): if the reviewed repo's own
`mr-review-instructions.yaml` names a custom group exactly `correctness`,
`security`, or `performance`, `buildLenses()` assigns base lenses to the
`lenses` object *after* custom ones, so the base lens silently overwrites
that custom entry under the same key. In practice this means a lens key of
`security` is always, unambiguously, the base security lens by the time
this JSON is produced — which is convenient for Step 3's routing rule
below, but it also means such a same-named custom group's own instructions
and file-filtered scope are lost for that iteration. Nothing to fix here;
just don't be surprised by it.

### Step 3 — Fan out reviewers

One reviewer subagent per key in `lenses`. Routing:

- Key is exactly `security` → dispatch `security-reviewer`.
- Every other key (`correctness`, `performance`, and every custom lens) →
  dispatch `code-reviewer`.

Both at `model: opus` (per the design's role table — reviewer lenses run
Opus regardless of that agent's own default). If neither agent type is
available in the current environment, fall back to `general-purpose` at
the same model, passing it the identical prompt described below.

**Dispatch every lens's reviewer in parallel** — issue all of the calls in
one batch (the Agent tool's multi-invocation-in-one-message pattern), not
one after another. Lenses are independent: each reviewer only ever sees its
own `files` slice, so there is no ordering dependency between them and no
reason to serialize.

Each reviewer's prompt must be self-contained and include:

1. The lens name (the `lenses` key) and its `type`.
2. The lens's `instructions` text verbatim (plus, if `--aigw` supplied
   extra context for this lens, that text appended after it).
3. The full `files` array for this lens verbatim: `[{ path, diff,
   original }]`. `diff` is already in the tagged `<chunk_header>`/`<line
   type="added|deleted|context|nonewline" old_line=".." new_line="..">`
   form `build-context.mjs` emits — tell the reviewer to read line numbers
   for `old_line`/`new_line` off those tags, not by counting.
4. For a `type: "custom"` lens: point it at
   `references/custom-instructions.md` §4 and require every finding's
   `comment` use the exact citation prefix `According to custom
   instructions in '<name>' (<paraphrase>): <comment>`, where `<name>` is
   this lens's exact key.
5. For a `type: "base"` lens: point it at the matching section of
   `references/review-lenses.md` for its checklist and severity
   calibration, and tell it explicitly **not** to use the custom-lens
   citation prefix.
6. The "stay in your lane" rule from `references/review-lenses.md`: report
   only findings squarely within this lens's own concern; don't flag
   something another lens would also flag just because it happens to touch
   both.
7. The exact required return shape, from `references/output-format.md`
   §1 — and nothing else in the response:
   ```json
   { "findings": [ { "file": "...", "old_line": "", "new_line": "42",
     "severity": "blocker|high|medium|low", "category": "kebab-slug",
     "lens": "<this lens's exact key>", "comment": "...",
     "suggestion": { "from": "...", "to": "..." } } ] }
   ```
   `suggestion` is optional and must be omitted entirely (not `null`) when
   there's no concrete drop-in replacement. `file` must be the file's
   `path` field exactly (the current/new path — never an old path from a
   rename). Exactly one of `old_line`/`new_line` may be `""`; never both.
   **The reviewer must never include a `key`/`id` field** — dedup keys are
   computed by the orchestrator, never by a reviewer (see Step 4).
   `{ "findings": [] }` is a valid, expected clean-pass result, not an
   error.

Parse each reviewer's response as JSON matching that shape. If parsing
fails, or the top-level shape doesn't match, retry that one reviewer once
with a corrective note ("your last reply wasn't valid JSON matching the
required schema — reply with only that JSON object, nothing else"). If it
still doesn't parse, treat that lens's findings as `[]` for this iteration,
note it in this iteration's progress narration, and continue — one bad
reviewer response must never abort the run.

### Step 4 — Merge + dedup

Collect every finding from every lens's response this iteration into one
flat list, tagging each with its lens (already present as the `lens`
field).

Compute each finding's dedup key exactly as `references/output-format.md`
§2 specifies:
```
key = sha1(file + ":" + new_line + ":" + category)
```
This must be computed by real code, never estimated by reasoning (an LLM
cannot reliably compute a SHA1 hash). Do it in one batch: write the
merged finding list to a scratch file next to `state.json`, then run a
short Node script to attach `key` to every entry and write the result back
out, e.g.:
```
node -e '
  const fs = require("fs"), crypto = require("crypto");
  const path = process.argv[1];
  const findings = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const f of findings) {
    f.key = crypto.createHash("sha1").update(f.file + ":" + f.new_line + ":" + f.category).digest("hex");
  }
  fs.writeFileSync(path, JSON.stringify(findings));
' <scratchpad>/loupe/<abs-repo-path-with-/-replaced-by-->/fresh-findings.json
```
Read the file back — every finding now carries `key`.

Drop every finding whose `key` is already in `state.seen` — it was already
judged (fixed, rejected, or deferred) in an earlier iteration and must not
resurface. What remains is this iteration's **fresh** finding set. If it's
empty, skip Step 5's judge dispatch entirely — there's nothing to triage —
and treat the judge result for the remainder of this iteration as
`{ actionable: [], rejected: [], stop: true, summary: "no new findings this iteration" }`.

### Step 5 — Judge

If the fresh finding set is non-empty, dispatch exactly one judge subagent:
`critic`, with `model: sonnet` (the design's role table runs the judge at
Sonnet even though `critic`'s own default is Opus — the judge is a
triage/consistency pass, not a deep-reasoning one, and this keeps ensemble
cost down). Fall back to `general-purpose` at `model: sonnet` if `critic`
isn't available.

Give the judge, self-contained in its prompt:

- Every fresh finding, each already carrying its `key` from Step 4 — the
  judge only ever echoes these keys back; it must never invent, recompute,
  or omit one.
- The current diff (or at least a pointer to re-run `build-context.mjs` if
  it needs to see it — but the merged findings plus their `comment`/
  `suggestion` text is normally enough).
- The currently configured `--severity-gate` value.
- **Severity ranks**, highest to lowest: `blocker` (4) > `high` (3) >
  `medium` (2) > `low` (1). A finding "clears the gate" when its rank is
  ≥ the gate's rank.
- The exact rules from `references/output-format.md` §3–§4, stated
  plainly: only `blocker`/`high` findings can ever land in `actionable`,
  and only when they clear the current gate and the judge doesn't reject
  them; `medium`/`low` can never be `actionable` no matter the gate.
  `rejected` is reserved for findings the judge affirmatively judges
  noise, duplicate-in-substance, or out of scope — **any** severity can be
  rejected, and a `blocker`/`high` finding the judge rejects goes to
  `rejected`, not `actionable`, even if it clears the gate. Gate-excluding
  a `blocker`/`high` finding is **not** a rejection — the judge must leave
  a gate-excluded finding out of both `actionable` and `rejected` rather
  than stuffing it into `rejected` to give it a bucket. `actionable` and
  `rejected` must be disjoint.
- The required return shape, `references/output-format.md` §3:
  ```json
  {
    "actionable": ["<key>", "..."],
    "rejected": [ { "key": "<key>", "reason": "..." } ],
    "stop": false,
    "summary": "one-line status of this iteration"
  }
  ```
  `stop: true` means "nothing from this pass still warrants further
  looping" — it can be true even alongside a non-empty `actionable`
  (findings about to be fixed this same iteration and expected to be the
  last needed pass), and it says nothing by itself about whether the loop
  will actually stop (see Step 6 — the orchestrator ANDs it with its own
  guards).

Update `state.findings`: for every key in `rejected[]`, upsert an entry
with `status: "rejected"`, the reason, and `judgedInIteration: <N>`. For
every key in `actionable[]`, upsert `status: "actionable"`,
`judgedInIteration: <N>` (Step 7 will move it to `"fixed"` or
`"unresolved"`). For every fresh finding whose key landed in **neither**
array (gate-excluded `blocker`/`high`, or un-rejected `medium`/`low`),
upsert `status: "deferred"`, `judgedInIteration: <N>`. Then append **every**
judged key (from both `actionable` and `rejected` — not the deferred ones,
which weren't judged) to `state.seen`, so a rejected finding never
resurfaces and a fixed one is never re-reported as new.

### Step 6 — Stop check

This decides only whether iteration `N+1` will run — it is evaluated
**after** Step 7 has already run for iteration `N` below. Read Step 7 (Fix)
before Step 6 (Stop check) in execution order even though they're numbered
6-then-7; the numbering matches the plan's task list, not the runtime
sequence.

```
judgeStop   = the judge's `stop` field this iteration (or the synthesized
              `stop: true` from Step 4 if no judge ran because the fresh
              set was empty)
noProgress  = (this iteration's `actionable` was empty)
              AND (no entry in state.findings has fixedInIteration === N)
              — the iteration that just completed found nothing new actionable
              AND fixed nothing in that same iteration.
atCap       = (N + 1) >= max-iterations
              — with the default of 3, iterations 0, 1, 2 run and a 4th
              never starts.

stop = judgeStop OR noProgress OR atCap
```

**Critical:** `stop` being true here never skips or cancels Step 7 for the
current iteration `N` — by the time this check runs, Step 7 has already
attempted every actionable and retry-carried finding for iteration `N`.
`stop: true` only means "don't start iteration `N+1`." Nothing dispatched
to the executor this run is ever silently dropped: if the loop ends while
a finding is still in `status: "unresolved"` (fix attempted and failed, or
— under `--no-fix` — never attempted), it is reported in the final
report's Deferred section as "attempted, unresolved" (Step 9,
`output-format.md` §5), never omitted.

### Step 7 — Fix

Runs once per iteration, immediately after Step 5, for every iteration
regardless of what Step 6 will decide.

```
fixQueue = this iteration's judge.actionable
           ∪ { keys in state.findings with status === "unresolved" carried from earlier iterations }
```

If `--no-fix`: skip execution entirely. Every key in `fixQueue` that came
from `judge.actionable` this iteration gets `status: "unresolved"` (never
attempted) rather than `"actionable"` left dangling, so Step 9 renders it
correctly; go straight to Step 6.

Otherwise, for each key in `fixQueue` (severity is always `blocker`/`high`
by construction — `medium`/`low` never enter `actionable`):

1. Dispatch `executor`, `model: sonnet`, with: the finding's `file`,
   `old_line`/`new_line`, `severity`, `category`, `comment`, and
   `suggestion` if present. Instruct it to fix only this issue in the
   working tree, to stay scoped to the flagged file unless the fix
   genuinely requires a companion change (e.g. a caller that must be
   updated too), and to never run `git commit`/`git push`/any history
   mutation.
2. **Same-file serialization:** if two or more keys in `fixQueue` target
   the same file, dispatch those sequentially — one executor call must
   complete before the next starts on that file — so concurrent edits
   can't clobber each other. Fixes on different files may run in
   parallel.
3. Confirm the fix: check that `git diff` now touches the finding's file
   in a way that addresses the comment (if a `suggestion` was given,
   confirm `from` no longer appears verbatim, or an equivalent change is
   present). If confirmed: `status: "fixed"`, `fixedInIteration: N`.
4. If not confirmed: retry the executor once more within this same
   iteration with a corrective note describing what's still wrong. If
   still not confirmed after the retry: `status: "unresolved"`,
   increment `fixAttempts`. It stays in `fixQueue` for the next iteration
   (carried forward) if the loop continues, or is reported as "attempted,
   unresolved" if this was the last iteration.

### Step 8 — Loop

If Step 6's `stop` is false: set `state.iteration = N + 1`, persist
`state.json`, and go back to Step 2 — the re-diff will pick up whatever
Step 7 just changed in the working tree, which is the entire point (fixed
code shifts what the next pass's reviewers see).

If `stop` is true: proceed to Step 9. Do not run Step 2 again.

### Step 9 — Report

Print the final human-facing report exactly once, built from every entry
ever written to `state.findings` across all iterations, bucketed per
`references/output-format.md` §5's priority-ordered, disjoint-and-total
rule (first match wins):

1. **Rejected** — `status === "rejected"`. Bullet text uses that finding's
   own rejection reason.
2. **Fixed** — `status === "fixed"`. Bullet text is the finding's own
   `comment`.
3. **Deferred** — everything else (`status === "deferred"` or
   `"unresolved"`), which is by construction every finding not caught by
   rule 1 or 2. Render per which of these applies:
   - `status === "unresolved"` → suffix `— attempted, unresolved`, no
     `Suggestion:` line.
   - `status === "deferred"`, severity `blocker`/`high` (gate-excluded) →
     suffix `` — excluded by `--severity-gate <value>` ``; render a
     `Suggestion:` line if the finding carries one.
   - `status === "deferred"`, severity `medium` → render a `Suggestion:`
     line if the finding carries one; omit the line if it doesn't.
   - `status === "deferred"`, severity `low` → informational only, never
     a `Suggestion:` line even if the finding carries one.

For any finding whose `new_line` is `""` (a pure-deletion finding), render
the locator as the bare path with no trailing colon or line number —
`` `app/util.rb` `` — never `` `app/util.rb:` ``.

Template (mirrors `references/output-format.md` §5 exactly):

```markdown
## loupe review report

### Fixed (N)
- `app/user.rb:42` [high/sql-injection] <comment> — fixed this iteration.

### Deferred (N)
- `app/order.rb:17` [medium/n-plus-one] <comment>
  Suggestion: replace `from` with `to`.
- `app/session.rb:9` [high/missing-null-check] <comment> — excluded by `--severity-gate blocker`.
- `app/cache.rb:23` [blocker/race-condition] <comment> — attempted, unresolved.

### Rejected (N)
- `app/util.rb:8` [low/naming] <comment> — judge: <rejected reason>

### Diff
Run `git diff --stat` (or `git diff`) in the working tree to see everything
loupe changed this run. Nothing was committed or pushed — review and
commit the changes yourself.
```

Actually run `git diff --stat` and include its real output under the
`### Diff` heading (the template's prose line is a fixed reminder that
always appears; the stat output is appended below it, not fabricated).
Nothing in this report is ever invented — a bucket with zero entries still
prints its `(0)` heading with no bullets under it, so the report's shape
is stable across runs.

## Agent fallback

If any of `code-reviewer`, `security-reviewer`, `critic`, or `executor` is
unavailable in the current environment, substitute `general-purpose` at
the same model the unavailable agent would have used (`opus` for
reviewers, `sonnet` for the judge and the executor), with the identical
prompt content described above. The loop's logic doesn't change — only
which agent type carries out a given dispatch.

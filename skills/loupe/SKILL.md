---
name: loupe
description: Headless iterative code review of the current branch's diff against its base, or of the entire repo with --all. Use when the user asks to review changes, review a branch or PR, run a pre-commit review, review the whole codebase/directory, or mentions loupe or REVIEW.yaml.
---

# loupe

`loupe` runs a headless, iterative code review against the current branch's
diff: an ensemble of per-lens reviewer subagents (one per active review
lens) reports findings, a judge subagent triages them, an executor fixes
what clears the bar — in the working tree only — and the whole thing
re-diffs and repeats. Looping matters because reviewer models hyperfocus on
whatever they saw first; changing the code between passes gives the next
pass a different, better-informed view. The loop stops on convergence, a
no-progress guard, or an iteration cap — never with a dispatched fix
silently lost.

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
  repo's own `REVIEW.yaml` are matched and cited.

## Arguments

Parsed from the skill invocation's argument string. All are optional.

| Flag | Default | Meaning |
|---|---|---|
| `--base <ref>` | the reviewed repo's default branch | The ref to diff against. Passed through to `build-context.mjs --base <ref>` when given; when omitted, let `build-context.mjs`'s own default-branch detection resolve it (see Step 2 — do not reimplement that detection here). |
| `--max-iterations <n>` | `3` | Hard cap on the number of review→fix passes. |
| `--fix` / `--no-fix` | `--fix` | Whether Step 6 dispatches the executor. Under `--no-fix`, actionable findings are never attempted and still surface in the final report's Deferred section as "attempted, unresolved" (per `output-format.md` §5 — that phrase covers both "attempted and failed" and "never attempted"). |
| `--severity-gate <level>` | `high` | The minimum severity a finding must clear to become actionable (see "Severity ranks" under Step 5). Accepts `blocker`\|`high`\|`medium`\|`low` — a finding is actionable exactly when its severity rank meets or exceeds the gate's rank and the judge doesn't reject it (Step 5/6), so lowering the gate to `medium` or `low` genuinely widens what gets auto-fixed. |
| `--committed` | off (review the working tree) | What to diff against `--base`. By default `loupe` reviews the **working tree** — every change not yet in the base, whether committed on the branch or still uncommitted (tracked edits and new untracked files) — so work-in-progress is reviewed and each pass's re-diff sees the edits Step 6 just made. Pass `--committed` to diff the commit range (`mergeBase..HEAD`) instead, reviewing only what has been committed (a PR/MR-style gate). Passed through to `build-context.mjs --committed`. |
| `--all` | off (diff against `--base`) | Review the **entire repository** instead of a diff — for a first look at a codebase with no meaningful base to compare against (e.g. a downloaded skill or a repo someone just handed you). Implemented as a diff against git's empty-tree object, so every tracked file is treated as newly added (`original` is always `null`). Passed through to `build-context.mjs --all`; when given, `--base` is ignored (there's no real base) and Step 2's default-branch detection is skipped. Combine with `--committed` to diff the empty tree only against `HEAD` (skips uncommitted/untracked work). **Trust note:** even under `--all`, `loupe` still reads that repo's on-disk `REVIEW.yaml` — its custom-lens `instructions` are passed verbatim to the reviewer and judge subagents, and its `disableDefaultLenses` can switch off `loupe`'s own base lenses — so only run `loupe` on repositories whose `REVIEW.yaml` you trust. |

## Safety rules (non-negotiable)

- **git-repo only.** Verified in Step 1. Outside a git repo, `loupe` stops
  immediately with a clear message and does nothing else.
- **Working-tree only, never commit or push, at any point in the loop.**
  Every fix Step 6 makes is a plain file edit. `loupe` never runs `git
  commit`, `git push`, or anything that mutates history or refs. The
  human reviews and commits after `loupe` exits — that decision is never
  automated away.
- **Cap = 3 iterations by default**, overridable via `--max-iterations`,
  enforced in Step 7. This is a backstop against a misbehaving judge or a
  codebase that never converges — it always fires eventually, no matter
  what the judge says.
- **Severity gate default = `high`.** Findings whose severity clears the
  gate and aren't rejected get auto-fixed. **Below** the gate, nothing is
  auto-fixed: `medium` is suggestion-only; `low`/nits are report-only. See
  Step 5/6.
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
   (schema below, Step 4/5/6) — this is what drives the no-progress guard
   and the final report; `seen` is only ever a flat array of keys.

### Step 2 — Build context

Run:
```
node "${CLAUDE_SKILL_DIR}/scripts/build-context.mjs" [--base <base>] [--committed] [--all]
```
from inside the reviewed repo (the script defaults `--repo` to
`process.cwd()`, which is the reviewed repo since that's where this skill
was invoked). `${CLAUDE_SKILL_DIR}` is the directory this `SKILL.md` file
lives in — Claude Code exports it when loupe runs as an installed plugin.
The script is always at `scripts/build-context.mjs` relative to that
directory, wherever this skill was installed; if the variable isn't set in
your environment, substitute the absolute path to this skill's own
directory. Include `--base <base>` only when
the user supplied one via the skill's own `--base` argument; otherwise omit
it and let the script's own default-branch detection run (symbolic-ref to
`origin/HEAD`, falling back to `main` then `master`). On iteration 0,
capture the `base` value the script returns in its JSON and reuse that
**exact** value verbatim as `--base` on every later iteration's
invocation, so the target can't silently drift mid-run if the remote's
default-branch pointer changes.

Pass `--all` through when the user supplied it via the skill's own `--all`
argument — it reviews the entire repository (a diff against git's
empty-tree object) instead of a branch's changes, for a first look at a
codebase with no meaningful base. Under `--all`, skip the `--base`
capture-and-pin above entirely: `build-context.mjs` ignores `--base` and
returns the fixed synthetic `base: "(empty tree)"`, which can't drift, so
there is nothing to pin across iterations.

Pass `--committed` through to `build-context.mjs` when the user supplied it
via the skill's own `--committed` argument; otherwise omit it and let the
script default to reviewing the working tree. Under `--committed` the diff is
the commit range `mergeBase..HEAD` (or, combined with `--all`, the empty
tree `..HEAD`), so a fix Step 6 writes to the working tree is **not** visible
on the next iteration's re-diff — in that mode the loop is effectively a
single pass (fixes are left for the human to review and commit). In the
default working-tree mode, Step 6's fixes *do* show up on the re-diff, which
is what makes the loop genuinely iterative.

Parse stdout as JSON: `{ base, mergeBase, mode, all, changedFiles, renamed,
generated, lenses }`. `mode` is `"working-tree"` (default) or `"committed"`
(under `--committed`) — it records what was diffed; `all` is `true` under
`--all`, `false` otherwise.

- If `changedFiles` is empty: print `loupe: nothing to review (no
  reviewable changes between <base> and HEAD)` and stop — skip straight
  past the rest of the loop to nothing (no report needed; there was never
  anything to report on).
- Otherwise, `lenses` is an object keyed by lens name. The base lenses come
  from the skill's bundled `rules/default.yaml` (`correctness`, `security`,
  `performance`, and `maintainability` on every changed file; `devops` only
  when the diff touches infra/CI files), plus one key per matched custom
  lens from the reviewed repo's own `REVIEW.yaml` (see
  `references/custom-instructions.md` §2). Each
  value is `{ type: "base"|"custom", agent, reference?, instructions,
  include_patterns?, exclude_patterns?, files: [{ path, diff, original }] }`.
  `agent` names the reviewer subagent to dispatch (Step 3); `reference`, when
  present, points at the lens's checklist section. Proceed to Step 3 with
  this object.

**Base lenses + disable.** The lens set is the bundled base lenses **minus**
any the repo turned off, **plus** the repo's custom lenses. A repo drops a
built-in it doesn't want with a top-level `disableDefaultLenses: [<name>, …]`
list in its `REVIEW.yaml` (names matched case-insensitively); those base lenses
are removed before the merge. Custom lenses are otherwise purely additive — to
*replace* a built-in, disable it and add your own differently-named lens.
(Reusing a base lens's exact name isn't the intended mechanism; if you do, the
custom one wins by load order, but prefer `disableDefaultLenses`.)

### Step 3 — Fan out reviewers

One reviewer subagent per key in `lenses`. Routing is **data-driven**: read
each lens value's `agent` field and dispatch that subagent — do not hardcode
routing by lens name.

- `agent: "security-reviewer"` → dispatch `security-reviewer`.
- `agent: "code-reviewer"` (the default) → dispatch `code-reviewer`.
- `agent: "general-purpose"` → dispatch `general-purpose`.

All at `model: opus` (per the design's role table — reviewer lenses run Opus
regardless of that agent's own default). If the named agent type isn't
available in the current environment, fall back to `general-purpose` at the
same model, passing it the identical prompt described below.

**Dispatch every lens's reviewer in parallel** — issue all of the calls in
one batch (the Agent tool's multi-invocation-in-one-message pattern), not
one after another. Lenses are independent: each reviewer only ever sees its
own `files` slice, so there is no ordering dependency between them and no
reason to serialize.

Each reviewer's prompt must be self-contained and include:

1. The lens name (the `lenses` key) and its `type`.
2. The lens's `instructions` text verbatim.
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
5. For a `type: "base"` lens: point it at its `reference` (the matching
   section of `references/review-lenses.md` — e.g. that lens's own
   `#correctness`/`#security`/`#performance`/`#maintainability`/`#devops`
   section) for its checklist and severity calibration, and tell it
   explicitly **not** to use the custom-lens citation prefix.
6. The "stay in your lane" rule from `references/review-lenses.md`: report
   only findings squarely within this lens's own concern; don't flag
   something another lens would also flag just because it happens to touch
   both.
7. Paste the reviewer finding contract from `references/output-format.md`
   §1 **verbatim** into the prompt, and require the reviewer to return
   only that JSON object, nothing else in the response. §1 already states
   every field rule that matters here — including that the reviewer must
   never include a `key`/`id` field, and that `{ "findings": [] }` is a
   valid, expected clean-pass result — do not restate or summarize them.

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
- The currently configured `--severity-gate` value and the severity ranks
  it's measured against (`references/output-format.md` §4 — do not
  restate the ranks here).
- Custom lenses' `instructions` text from the build-context output, if any
  (`type: "custom"` entries) — needed for the repo-overrides rule
  (`references/output-format.md` §3).
- Paste `references/output-format.md` §3–§4 **verbatim** into the judge
  prompt. The actionable/rejected/gate-exclusion rules, the disjointness
  requirement, and the repo-overrides rule are all specified there — do
  not restate, summarize, or reinterpret them here.
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
  will actually stop (see Step 7 — the orchestrator ANDs it with its own
  guards).

Update `state.findings`: for every key in `rejected[]`, upsert an entry
with `status: "rejected"`, the reason, and `judgedInIteration: <N>`. For
every key in `actionable[]`, upsert `status: "actionable"`,
`judgedInIteration: <N>` (Step 6 will move it to `"fixed"` or
`"unresolved"`). For every fresh finding whose key landed in **neither**
array (excluded by the gate, or otherwise left unclassified by the judge),
upsert `status: "deferred"`, `judgedInIteration: <N>`. Then append **every**
key handed to the judge this iteration — actionable, rejected, and
deferred (left unclassified) alike — to `state.seen`, so a rejected
finding never resurfaces, a fixed one is never re-reported as new, and a
deferred one doesn't churn the judge again under the same key next
iteration.

### Step 6 — Fix

Runs once per iteration, immediately after Step 5, for every iteration
regardless of what Step 7 (the stop check below) will decide.

```
fixQueue = this iteration's judge.actionable
           ∪ { keys in state.findings with status === "unresolved" carried from earlier iterations }
```

If `--no-fix`: skip execution entirely. Every key in `fixQueue` that came
from `judge.actionable` this iteration gets `status: "unresolved"` (never
attempted) rather than `"actionable"` left dangling, so Step 9 renders it
correctly; go straight to Step 7.

Otherwise, for each key in `fixQueue` (severity always clears the current
`--severity-gate` by construction — that's what got it into `actionable`
in the first place):

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

### Step 7 — Stop check

This decides only whether iteration `N+1` will run — it is evaluated
after the Fix step (Step 6) has already run for iteration `N`.

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

**Critical:** `stop` being true here never skips or cancels Step 6 for the
current iteration `N` — by the time this check runs, Step 6 has already
attempted every actionable and retry-carried finding for iteration `N`.
`stop: true` only means "don't start iteration `N+1`." Nothing dispatched
to the executor this run is ever silently dropped: if the loop ends while
a finding is still in `status: "unresolved"` (fix attempted and failed, or
— under `--no-fix` — never attempted), it is reported in the final
report's Deferred section as "attempted, unresolved" (Step 9,
`output-format.md` §5), never omitted.

### Step 8 — Loop

If Step 7's `stop` is false: set `state.iteration = N + 1`, persist
`state.json`, and go back to Step 2 — the re-diff will pick up whatever
Step 6 just changed in the working tree, which is the entire point (fixed
code shifts what the next pass's reviewers see).

If `stop` is true: proceed to Step 9. Do not run Step 2 again.

### Step 9 — Report

Print the final human-facing report exactly once, built from every entry
ever written to `state.findings` across all iterations. Render it exactly
per `references/output-format.md` §5 — the three buckets' membership and
priority rules, the per-severity rendering (the gate-excluded suffix, the
`Suggestion:` line rules, the pure-deletion locator), and the markdown
template are all specified there; do not duplicate or reinterpret them
here.

Two things this step must still do, beyond what §5 itself specifies:

- Actually run `git diff --stat` and append its real output under the
  `### Diff` heading (the template's prose line is a fixed reminder that
  always appears; the stat output is appended below it, not fabricated).
- A bucket with zero entries still prints its `(0)` heading with no
  bullets under it, so the report's shape is stable across runs.

## Agent fallback

If any of `code-reviewer`, `security-reviewer`, `critic`, or `executor` is
unavailable in the current environment, substitute `general-purpose` at
the same model the unavailable agent would have used (`opus` for
reviewers, `sonnet` for the judge and the executor), with the identical
prompt content described above. The loop's logic doesn't change — only
which agent type carries out a given dispatch.

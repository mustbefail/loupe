# loupe

A headless iterative code-review loop for Claude Code. An ensemble of review lenses plus a judge, running in a loop to refine code quality.

## Name Origin

- **loop**: the iterative feedback cycle that drives continuous improvement.
- **lens**: each specialized review perspective that examines code from a unique angle.

Together they form `loupe` — an optical instrument for close examination and inspection.

## Installation

`loupe` ships as a Claude Code plugin distributed through its own marketplace.
Add the marketplace, then install the plugin:

```
/plugin marketplace add mustbefail/loupe
/plugin install loupe@loupe
```

Once installed, invoke it from inside any git repository — either ask Claude
to run a loupe review of the current branch, or call the `loupe` skill
directly. By default it reviews everything on your branch that isn't in the
base yet — **including uncommitted work** (tracked edits and new untracked
files) — so you can review changes before committing them, and each fix pass
sees its own edits on the next re-diff. All arguments are optional:

```
--base <ref>            # ref to diff against (default: repo's default branch)
--committed             # review only committed changes (mergeBase..HEAD); default also includes the working tree
--all                   # review the entire repo (diff against git's empty tree) instead of just the base..HEAD diff
--max-iterations <n>    # hard cap on review→fix passes (default: 3)
--fix | --no-fix        # whether to auto-fix actionable findings (default: --fix)
--severity-gate <level> # min severity to auto-fix: blocker|high|medium|low (default: high)
--verify <cmd>          # command that must still pass after a fix pass (default: autodetected)
--no-verify             # turn the post-fix regression gate off entirely
```

The default `--severity-gate high` is a deliberately high bar — `blocker`/`high`
means something is actually broken, not just a judgement call — but that also
means `--fix` (itself the default) can easily change nothing. Lens reviewers
skew toward `medium`/`low` findings on code that's already in reasonable shape:
a real run of four lenses over a competently-written 4-file diff came back with
20 findings and zero at `high` or `blocker` (12 `medium`, 8 `low`). On a codebase
like that, expect the default run to be effectively read-only, with everything
reported as Deferred rather than Fixed. Pass `--severity-gate medium` to have
`loupe` actually change code.

Just downloaded or cloned a codebase and want a review of everything in it,
not just recent changes? Pass `--all` — `loupe` diffs against git's empty
tree, so every tracked file is treated as newly added and gets reviewed. The
repository still needs to be a git repo (that safety rule doesn't change);
for a plain directory, run `git init && git add -A` first, then invoke
`loupe --all`. Trust note: `loupe` still reads that repo's own `REVIEW.yaml`
if it has one — its custom-lens instructions and `disableDefaultLenses` are
honored the same as in any other mode — so only point `--all` at a
repository whose `REVIEW.yaml` you trust.

### Local development

Working on `loupe` itself? Point Claude Code at this checkout as a local
marketplace instead of the GitHub one:

```
/plugin marketplace add ./
/plugin install loupe@loupe
```

Run the test suite with `npm test`.

## Verification: fixes that don't break the build

An auto-fix that silently breaks the typecheck or the test suite is worse than
no fix. `loupe`'s lenses can't catch that on their own — they're told not to
report what a linter or type-checker already catches, and they read the diff
rather than running it. So after each fix pass, `loupe` runs the repo's own
commands and compares against a baseline it captured *before* touching
anything (a working tree under review is frequently already red — that's not
`loupe`'s doing, and it isn't reported as such).

Commands are autodetected: `typecheck`/`type-check`/`tsc`, `lint`, and `test`
from `package.json` scripts (respecting the lockfile's package manager), or
the same target names from a `Makefile`. Only those *names* are matched — but
what each name runs is whatever the repo's own script or target says, so this
gate executes code the repository controls, including code introduced by the
very diff you are reviewing, and including uncommitted files. So `loupe`
**prints the resolved commands and asks before running any of them** the first
time a fix is about to land. Decline and the run continues as if
`--no-verify` had been passed, with the declined list recorded in the report.

Set `verify:` in `REVIEW.yaml` to override the guess, `--verify <cmd>` for a
one-off (yours, so it's disclosed but not queried), `--no-verify` to switch the
gate off. Nothing is executed until a fix is actually about to be dispatched —
a review that finds nothing worth fixing runs no repo commands at all.

If a command that passed before now fails, `loupe` hands the failure output to
one repair attempt. If that doesn't clear it, the finding is reported as
"applied, verification regressed" with the real command output — never as
"fixed". Nothing is ever reverted: `loupe` works in a tree that usually holds
your own uncommitted changes, so undoing a bad fix could take your work with
it. That call stays yours, same as committing.

Under `--all`, **nothing the repo supplies is resolved at all** — neither an
autodetected script nor its own `REVIEW.yaml` `verify:` list. That mode is for
a repo nobody has vetted yet, and a `verify:` entry is a string handed to a
shell on your machine, not prompt text handed to a reviewing model the way
custom-lens instructions are; the two are not the same trust decision. Only
your own `--verify` enables the gate there.

## External rules: `REVIEW.yaml`

`loupe` ships five built-in lenses, defined in the skill's own
`rules/default.yaml`: `correctness`, `security`, `performance`, and
`maintainability` run on every changed file, and `devops` runs when the diff
touches infrastructure/CI files (Dockerfiles, Compose, Terraform, GitHub
Actions, Ansible, Kubernetes, CDK, …). See `references/review-lenses.md` for
each lens's checklist.

On top of those, `loupe` picks up per-repo custom lenses from an optional
`REVIEW.yaml` at the root of the repository being reviewed. If the file
doesn't exist, only the built-in lenses run. Each entry becomes its own lens:

```yaml
instructions:
  - name: TypeScript Quality
    fileFilters:
      - "**/*.ts"
      - "!**/*.test.ts"
    instructions: |
      Enforce our TypeScript conventions: no `any` used to silence the
      compiler (prefer `unknown` plus narrowing), explicit return types on
      exported functions, and no non-null `!` assertions that paper over a
      possibly-undefined value.
```

- `name` — free-text identifier; also shown in the lens's findings. Custom
  lenses run **in addition** to the built-ins; to drop a built-in, disable it
  (below) rather than reusing its name.
- `fileFilters` *(optional)* — glob patterns. A plain pattern (`**/*.ts`) is
  an include; a `!`-prefixed pattern (`!**/*.test.ts`) is an exclude. A file is in
  scope when it matches at least one include (or there are no includes at
  all, meaning "everything") and matches no exclude. Omit the key to apply
  the lens to every file.
- `agent` *(optional)* — which reviewer runs the lens: `code-reviewer`
  (default), `security-reviewer`, or `general-purpose`.
- `instructions` — the rules to enforce; a `|` block can bundle several, each
  checked and reported independently.

To turn a built-in lens **off** entirely (rather than replace it), add a
top-level `disableDefaultLenses:` list (names are case-insensitive):

```yaml
disableDefaultLenses:
  - performance
```

To pin the verification commands instead of letting `loupe` guess them, add a
top-level `verify:` list. They run in the order given and stop at the first
failure `loupe` itself introduced; a command that was already red before the
run doesn't halt the rest, so put the cheap checks first. An empty list
(`verify: []`) opts out of the gate without turning off autodetection
elsewhere:

```yaml
verify:
  - npm run typecheck
  - npm test
```

A fuller, commented example lives in [`examples/REVIEW.yaml`](examples/REVIEW.yaml).
See `references/custom-instructions.md` for the citation convention custom-lens
findings use and how matching interacts with the base lenses.

## Known limitations

- Custom-instruction glob matching is O(n²) per `**` segment on non-matching paths; fine for real git paths (~3ms worst case) but pathological multi-`**` patterns on very deep trees could be slow.
- `parseDiff` does not decode git's quoted paths (`core.quotePath`), so changed files with spaces or non-ASCII names may be skipped from review.
- `check-attr` receives all changed paths as CLI args, which could hit `ARG_MAX` on an extremely large diff.
- The dedup key depends on a finding's line number, which shifts when an earlier fix in the same file adds or removes lines — an unresolved or rejected finding can resurface under a new key on the next iteration (bounded by `--max-iterations`).
- The verification gate runs once per iteration, after all of that iteration's fixes, so when several fixes land together a regression can only be attributed to a specific one if the failure output names its file. When it names none, the regression is still reported in full, just not pinned to a finding — a deliberate choice over guessing.
- A verification command that was already failing before the run makes the gate blind for that command: a regression inside an already-red test suite can't be distinguished from the failure that was there first.
- `--all` reviews every tracked file, so on a large repository it produces a correspondingly large per-lens context; it's most useful on small-to-medium codebases. Glob-scoped lenses (e.g. `devops`) partially bound the cost, since they only run on their matching files.

## Acknowledgements

`loupe` was built under the inspiration of GitLab Duo's code reviewer — its
diff-scoped, per-file custom-instruction review model shaped this skill's
design.

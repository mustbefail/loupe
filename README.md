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
```

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

A fuller, commented example lives in [`examples/REVIEW.yaml`](examples/REVIEW.yaml).
See `references/custom-instructions.md` for the citation convention custom-lens
findings use and how matching interacts with the base lenses.

## Known limitations

- Custom-instruction glob matching is O(n²) per `**` segment on non-matching paths; fine for real git paths (~3ms worst case) but pathological multi-`**` patterns on very deep trees could be slow.
- `parseDiff` does not decode git's quoted paths (`core.quotePath`), so changed files with spaces or non-ASCII names may be skipped from review.
- `check-attr` receives all changed paths as CLI args, which could hit `ARG_MAX` on an extremely large diff.
- The dedup key depends on a finding's line number, which shifts when an earlier fix in the same file adds or removes lines — an unresolved or rejected finding can resurface under a new key on the next iteration (bounded by `--max-iterations`).
- `--all` reviews every tracked file, so on a large repository it produces a correspondingly large per-lens context; it's most useful on small-to-medium codebases. Glob-scoped lenses (e.g. `devops`) partially bound the cost, since they only run on their matching files.

## Acknowledgements

`loupe` was built under the inspiration of GitLab Duo's code reviewer — its
diff-scoped, per-file custom-instruction review model shaped this skill's
design.

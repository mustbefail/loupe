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
--max-iterations <n>    # hard cap on review→fix passes (default: 3)
--fix | --no-fix        # whether to auto-fix actionable findings (default: --fix)
--severity-gate <level> # min severity to auto-fix: blocker|high|medium|low (default: high)
```

### Local development

Working on `loupe` itself? Point Claude Code at this checkout as a local
marketplace instead of the GitHub one:

```
/plugin marketplace add ./
/plugin install loupe@loupe
```

Run the test suite with `npm test`.

## External rules: `REVIEW.yaml`

`loupe` always applies its three built-in, general-purpose lenses
(`correctness`, `security`, `performance` — see `references/review-lenses.md`).
On top of those, it will pick up per-file custom rules from an optional
`REVIEW.yaml` file at the root of the repository being reviewed. If the
file doesn't exist, `loupe` just runs the built-in lenses.

Each entry in `REVIEW.yaml` becomes its own review lens, scoped to the
files it matches:

```yaml
instructions:
  - name: Ruby Quality
    fileFilters:
      - "**/*.rb"
      - "!spec/**"
    instructions: |
      Enforce our Ruby style guide: prefer keyword arguments for methods
      with more than two parameters, avoid rescuing StandardError broadly,
      require frozen string literals.
```

- `name` — a free-text identifier for the lens; it also shows up in that
  lens's findings so you can tell a custom rule apart from a built-in one.
- `fileFilters` — a list of glob patterns. A plain pattern (e.g. `**/*.rb`)
  is an include filter; prefixing a pattern with `!` (e.g. `!spec/**`)
  makes it an exclude filter instead. A file is in scope for the group when
  it matches at least one include pattern (or there are no include
  patterns at all, meaning "everything") and doesn't match any exclude
  pattern.
- `instructions` — a free-text block applied to every matching file. It can
  bundle multiple directives; each is checked independently and reported as
  a separate finding when violated.

See `references/custom-instructions.md` for the full source format, the
citation convention custom-lens findings use, and how matching interacts
with the base lenses.

## Known limitations

- Custom-instruction glob matching is O(n²) per `**` segment on non-matching paths; fine for real git paths (~3ms worst case) but pathological multi-`**` patterns on very deep trees could be slow.
- `parseDiff` does not decode git's quoted paths (`core.quotePath`), so changed files with spaces or non-ASCII names may be skipped from review.
- `check-attr` receives all changed paths as CLI args, which could hit `ARG_MAX` on an extremely large diff.

## Acknowledgements

`loupe` was built under the inspiration of GitLab Duo's code reviewer — its
diff-scoped, per-file custom-instruction review model shaped this skill's
design.

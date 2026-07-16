# Custom Instructions

In addition to the three base lenses (`review-lenses.md`), `loupe` picks up
custom review lenses from the **reviewed repository's own**
`.gitlab/duo/mr-review-instructions.yaml` (this file lives in the project
being reviewed, not in `loupe` itself). This document explains where those
lenses come from, how a reviewer subagent should apply one, and the exact
citation format a custom-lens finding must use.

## 1. Source format

`.gitlab/duo/mr-review-instructions.yaml` holds a top-level `instructions:`
sequence. Each item is a named group:

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

- `name` — a free-text identifier for the group. This exact string becomes
  the lens name (the key under `lenses` in `build-context.mjs`'s output,
  and the value a reviewer for this lens reports in the finding's `lens`
  field).
- `fileFilters` — a list of glob patterns using glob matching (see `fnmatch`
  in `build-context.mjs`) — this is **not** Python's `fnmatch` module (that
  module has no `**` special-casing); it is loupe's own matcher:
  - A bare `*` compiles to `.*` and **does** cross a `/` on its own — e.g.
    `*.rb` matches `app/models/user.rb`, not just files at the repo root.
  - `**` immediately followed by `/` means "zero or more directory
    segments" — e.g. `db/migrate/**/*.rb` matches both `db/migrate/x.rb`
    (zero segments) and `db/migrate/a/b/x.rb` (two segments).
  - `**` at the end of a pattern, or not immediately followed by `/`,
    behaves the same as a bare `*` (matches any run of characters,
    including `/`).
  - `?` matches exactly one character; `[...]` is a character class,
    including the negated form `[!...]`.

  An entry prefixed with `!` is an **exclude** pattern instead of an
  include pattern (the `!` itself is stripped before the glob is matched
  — it is not part of the character-class syntax above).
- `instructions` — a free-text block. It may bundle several distinct
  directives/rules under one group — nothing requires it to be a single
  rule.

`loupe` only reads this file; it never writes it.

## 2. How `build-context.mjs` turns this into lenses

1. `loadCustomInstructions()` parses the YAML and, per group, splits
   `fileFilters` into `include_patterns` (entries without `!`) and
   `exclude_patterns` (entries with `!`, stripped of the prefix).
2. `buildLenses()` filters the repo's changed, reviewable files against
   each group's patterns (`matchesInstruction`: a file matches if it hits
   an include pattern — or there are no include patterns, meaning "all
   files" — **and** it doesn't hit an exclude pattern).
3. If **at least one** changed file matches a group, a lens is created,
   keyed by the group's exact `name`:
   ```json
   {
     "type": "custom",
     "instructions": "<the group's trimmed instructions text>",
     "include_patterns": ["**/*.rb"],
     "exclude_patterns": ["spec/**"],
     "files": [ { "path": "...", "diff": "...", "original": "..." } ]
   }
   ```
   `files` contains only the subset of changed files that matched this
   group — not the full changed set.
4. If **no** changed file matches a group, no lens is created for it that
   iteration — the group is silently skipped, not reported as an error.
5. If `.gitlab/duo/mr-review-instructions.yaml` doesn't exist, or fails to
   parse, `loadCustomInstructions()` returns `[]`: no custom lenses run
   that iteration, only the three base lenses do. This is not an error
   condition either.

A file can match more than one group's `fileFilters`. When that happens, the
file appears in more than one lens's `files` list — once per matching
group — and is reviewed independently against each group's own
`instructions`. There is no de-duplication across groups; a file being
subject to two independent custom rule-sets at once is expected, not a bug.

## 3. What the reviewer subagent must do

Each custom-lens reviewer subagent receives exactly one group's
`instructions` text and exactly that group's matched `files` slice (path +
diff + original, per the `files: [{path, diff, original}]` shape emitted
by `build-context.mjs`'s `buildLenses()` and shown in §2 above —
`output-format.md` does not define this shape, only the finding contract
reviewers must return). Apply **only** this group's instructions to
**only** these files:

- Do not apply another group's rules, even if you happen to know about them
  (you weren't given them for a reason — another subagent owns that lens).
- Do not review files outside your `files` list. A file omitted from your
  slice either doesn't match your group's `fileFilters`, or matches a
  different group's — either way it's out of scope for you. (It is still
  covered by the three base lenses regardless of which custom lenses touch
  it.)
- If the group's `instructions` bundles several directives, treat each as
  a separate thing to check for, but still report findings using the one
  citation format below — one finding per concrete problem found, not one
  finding per directive in the block.

## 4. Citation format

Every finding produced by a custom lens must format its `comment` field as:

```
According to custom instructions in '<name>' (<paraphrase>): <comment>
```

- `<name>` — the exact lens name (the YAML group's `name`, unchanged —
  matches the `lens` field and the `lenses` object key from
  `build-context.mjs`).
- `<paraphrase>` — a short, few-word restatement of *which* directive
  within the group's `instructions` block justifies this specific finding.
  Since a group's `instructions` can bundle multiple rules, the paraphrase
  lets a human reading the report see which one applied without opening
  the YAML file.
- `<comment>` — the normal explanation of what's wrong here and why, same
  as any other finding's comment.

Example, for the `Ruby Quality` group above, flagging a broad rescue:

```
According to custom instructions in 'Ruby Quality' (avoid broad StandardError rescues): this rescue swallows every StandardError subclass, including ones the caller needs to see (e.g. ActiveRecord::RecordNotFound), silently returning nil instead.
```

This prefix format is reserved for custom-lens findings. Base-lens findings
(`correctness`/`security`/`performance`) never use it — the presence or
absence of this prefix is how the final report (and a human reading it)
tells a repo-specific rule finding apart from one of `loupe`'s built-in
checks at a glance.

This citation format is loupe's own convention for labeling individual
findings — it is not shared with, or ported from, `build-context.mjs`'s
`formatCustomInstructions()`, which uses different wording (`For files
matching "<patterns>" (excluding: <patterns>) - <name>:`) to introduce a
group's instructions block to the reviewer model in the first place. That
function's output is what a reviewer *reads* to learn the rules; the
`According to custom instructions in '<name>' (<paraphrase>): <comment>`
format above is what a reviewer *writes* back, per finding, and the two
are independent conventions that happen to both reference the group's
`name`.

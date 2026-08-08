# Custom Instructions

In addition to the base lenses (`review-lenses.md`), `loupe` picks up
custom review lenses from the **reviewed repository's own**
`REVIEW.yaml` (this file lives at the root of the project being reviewed,
not in `loupe` itself). This document explains where those lenses come
from, how a reviewer subagent should apply one, and the exact citation
format a custom-lens finding must use.

## 1. Source format

`REVIEW.yaml` holds a top-level `instructions:` sequence. Each item is a
named group:

```yaml
instructions:
  - name: TypeScript Quality
    fileFilters:
      - "**/*.ts"
      - "!**/*.test.ts"
    instructions: |
      Enforce our TypeScript conventions: no `any` used to silence the compiler
      (prefer `unknown` plus narrowing), explicit return types on exported
      functions, and no non-null `!` assertions that paper over a
      possibly-undefined value.
```

- `name` — a free-text identifier for the group. This exact string becomes
  the lens name (the key under `lenses` in `build-context.mjs`'s output,
  and the value a reviewer for this lens reports in the finding's `lens`
  field). Giving a group the same `name` as a base lens (`correctness`,
  `security`, `performance`, `maintainability`, `devops`) — matched
  **exactly, case included**, unlike `disableDefaultLenses`, which compares
  case-insensitively — **replaces** that base lens rather than running
  alongside it — the repo's own instructions
  and `fileFilters` are used, and the built-in ones for that name never
  run. That is a second way to drop a base lens, distinct from listing it
  under `disableDefaultLenses`, and the report distinguishes them: a
  replaced lens is reported as shadowed, a listed one as disabled.
- `fileFilters` *(optional)* — a list of glob patterns using glob matching (see `fnmatch`
  in `build-context.mjs`) — this is **not** Python's `fnmatch` module (that
  module has no `**` special-casing); it is loupe's own matcher:
  - A bare `*` compiles to `.*` and **does** cross a `/` on its own — e.g.
    `*.ts` matches `src/models/user.ts`, not just files at the repo root.
  - `**` immediately followed by `/` means "zero or more directory
    segments" — e.g. `src/**/*.ts` matches both `src/x.ts`
    (zero segments) and `src/a/b/x.ts` (two segments).
  - `**` at the end of a pattern, or not immediately followed by `/`,
    behaves the same as a bare `*` (matches any run of characters,
    including `/`).
  - `?` matches exactly one character; `[...]` is a character class,
    including the negated form `[!...]`.

  An entry prefixed with `!` is an **exclude** pattern instead of an
  include pattern (the `!` itself is stripped before the glob is matched
  — it is not part of the character-class syntax above).

  `fileFilters` is **optional**: omit it entirely to apply the lens to every
  changed file (equivalent to a single `**` include).
- `agent` *(optional)* — which reviewer subagent runs this lens:
  `code-reviewer` (the default), `security-reviewer`, or `general-purpose`.
  It surfaces as the lens's `agent` field and drives the Step 3 routing in
  `SKILL.md`.
- `reference` *(optional)* — a doc path/anchor the reviewer should consult
  for a fuller checklist (the built-in lenses use it to point at their
  section of `review-lenses.md`).
- `instructions` — a free-text block. It may bundle several distinct
  directives/rules under one group — nothing requires it to be a single
  rule.

`loupe` only reads this file; it never writes it.

**Disabling base lenses.** Custom lenses run *in addition* to the built-in
lenses. To drop a built-in lens — to remove it, or to replace it with your own
differently-named lens — add a top-level `disableDefaultLenses:` list (block
sequence or inline `[a, b]`; names matched case-insensitively) alongside
`instructions:`:

```yaml
disableDefaultLenses:
  - performance
instructions:
  - name: ...
```

**Pinning the verification commands.** A third optional top-level key,
`verify:`, is a list of shell commands `loupe` runs after each fix pass to
confirm its own fixes didn't break the repo (`SKILL.md` Step 7). They run in
the order given and stop at the first failure `loupe` itself introduced; a
command that was already red before the run doesn't halt the rest. Writing the
key with an empty list (`verify: []`) opts the repo out of the gate — the key's
presence is what counts, so that is never mistaken for an absent key and never
falls back to autodetection. Absent the key entirely, `loupe` autodetects a
typecheck/lint/test command from the repo's `package.json` scripts or
`Makefile` targets; set it explicitly when that guess would be wrong:

```yaml
verify:
  - npm run typecheck
  - npm test
```

Unlike everything else in this file, these are **not** prompt text for a
reviewing model — they are strings handed to a shell on the reviewer's
machine. Two consequences follow, and they are the reason `verify:` is not
governed by the same trust note as custom-lens `instructions`:

- Before the first one runs, `loupe` prints the resolved list and asks the
  human to authorize it (`SKILL.md` Step 6, the consent gate). Declining
  continues the run with the gate off. Shipping a `verify:` list is a request,
  not an authorization.
- Under `--all` the list is **not resolved at all**; only the reviewer's own
  `--verify` enables the gate there. `SKILL.md`'s verification safety rule
  carries the reasoning.

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
     "include_patterns": ["**/*.ts"],
     "exclude_patterns": ["**/*.test.ts"],
     "files": [ { "path": "...", "diff": "...", "original": "..." } ]
   }
   ```
   `files` contains only the subset of changed files that matched this
   group — not the full changed set.
4. If **no** changed file matches a group, no lens is created for it that
   iteration — the group is silently skipped, not reported as an error.
5. If `REVIEW.yaml` doesn't exist, or fails to parse,
   `loadCustomInstructions()` returns `[]`: no custom lenses run
   that iteration, only the base lenses do. This is not an error
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
  covered by the base lenses regardless of which custom lenses touch
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

Example, for the `TypeScript Quality` group above, flagging a compiler-silencing `any`:

```
According to custom instructions in 'TypeScript Quality' (no `any` used to silence the compiler): typing this value as `any` turns off type checking for every downstream use, so a genuine type error here would surface only at runtime; narrow from `unknown` instead.
```

This prefix format is reserved for custom-lens findings. Base-lens findings
(`correctness`/`security`/`performance`/`maintainability`/`devops`) never
use it — the presence or absence of this prefix is how the final report
(and a human reading it) tells a repo-specific rule finding apart from one
of `loupe`'s built-in checks at a glance.

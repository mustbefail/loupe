# Custom Instructions

In addition to the base lenses (`review-lenses.md`), `loupe` picks up
custom review lenses from the **reviewed repository's own**
`REVIEW.json` (this file lives at the root of the project being reviewed,
not in `loupe` itself). This document explains where those lenses come
from, how a reviewer subagent should apply one, and the exact citation
format a custom-lens finding must use.

## 1. Source format

`REVIEW.json` holds a top-level `instructions` array. Each item is a
named group:

```json
{
  "instructions": [
    {
      "name": "TypeScript Quality",
      "fileFilters": ["**/*.ts", "!**/*.test.ts"],
      "instructions": "Enforce our TypeScript conventions: no `any` used to silence the compiler (prefer `unknown` plus narrowing), explicit return types on exported functions, and no non-null `!` assertions that paper over a possibly-undefined value."
    }
  ]
}
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
differently-named lens — add a top-level `disableDefaultLenses` array (names
matched case-insensitively) alongside `instructions`:

```json
{
  "disableDefaultLenses": ["performance"],
  "instructions": [ { "name": "..." } ]
}
```

**Pinning the verification commands.** A third optional top-level key,
`verify`, is a list of shell commands `loupe` runs after each fix pass to
confirm its own fixes didn't break the repo (`SKILL.md` Step 7). They run in
the order given and stop at the first failure `loupe` itself introduced; a
command that was already red before the run doesn't halt the rest. Writing the
key with an empty array (`"verify": []`) opts the repo out of the gate — the
key's presence is what counts, so that is never mistaken for an absent key and
never falls back to autodetection. Absent the key entirely, `loupe` autodetects
a typecheck/lint/test command from the repo's `package.json` scripts or
`Makefile` targets; set it explicitly when that guess would be wrong:

```json
{ "verify": ["npm run typecheck", "npm test"] }
```

Unlike everything else in this file, these are **not** prompt text for a
reviewing model — they are strings handed to a shell on the reviewer's
machine. Two consequences follow, and they are the reason `verify` is not
governed by the same trust note as custom-lens `instructions`:

- Before the first one runs, `loupe` prints the resolved list and asks the
  human to authorize it (`SKILL.md` Step 6, the consent gate). Declining
  continues the run with the gate off. Shipping a `verify` list is a request,
  not an authorization.
- Under `--all` the list is **not resolved at all**; only the reviewer's own
  `--verify` enables the gate there. `SKILL.md`'s verification safety rule
  carries the reasoning.

## 1a. Input forms and malformed handling

**This table is the single source of truth for what a repo may legally
*write* in `REVIEW.json`, and what happens when it writes something else —
it is not about the shape `build-context.mjs` hands back internally.** That
output shape — `{ instructions, verify, disableDefaultLenses }`, always
present in that exact form even when nothing parsed — is defined once, in
the block comment above `parseConfig` in `build-context.mjs`, and is a
**different contract** from the one below: this table describes the repo's
own file on disk as written; that comment describes what `build-context.mjs`
does with it afterward. Don't merge the two — a "legal input form" here and
a "field on the parsed config" there answer different questions, even where
they share a name like `verify`.

Every malformed form below produces a *notice* (`{ path, reason }`) rather
than an error that stops the run. How those notices render in the final
report is `references/output-format.md` §5's job (see its Config notices
entry), not this file's. The `reason` values themselves are likewise defined
once, in `parseConfig`'s own comment in `build-context.mjs` — this table
names them for context but does not redefine them.

| Key | Legal forms | Malformed form → what happens |
|---|---|---|
| *(whole file)* | A JSON object at the top level. | Text that isn't valid JSON at all — including an empty file, which `JSON.parse` rejects the same way as garbage — → `parse-error` at path `""`. Valid JSON whose top level isn't an object (an array, `null`, a bare string or number) → `shape-invalid` at path `""`. Either way the whole config is treated as absent: `instructions: []`, `verify` unset, `disableDefaultLenses: []` — nothing is rescued from a file rejected at this level. |
| *(no `REVIEW.json`, but a leftover `REVIEW.yaml` exists)* | N/A — `REVIEW.yaml` is the legacy filename; see the migration note in `README.md`. | Not read at all → `yaml-unsupported` at path `"REVIEW.yaml"`. Custom lenses, `disableDefaultLenses`, and `verify` are all ignored for this repo until it has a valid `REVIEW.json`. |
| `instructions` | An array of group objects (see the JSON example above). | Present but not an array → `shape-invalid` at `instructions`; the whole key drops to `[]`. |
| `instructions[i]` | An object with a non-empty string `name` and a non-empty string `instructions`; `fileFilters`, `agent`, `reference` optional. | `name` or `instructions` missing, not a string, or a whitespace-only string (including a group that is itself a number, boolean, array, or `null`) → `item-dropped` at `instructions[i]` — only that one group is dropped; the rest of the array still parses. |
| `instructions[i].fileFilters` | Omitted, `null`, a single string, or an array of strings (a leading `!` marks an exclude). | A non-string element inside the array → `item-dropped` at `instructions[i].fileFilters[j]` — that element only. **A whole-value type error (e.g. `"fileFilters": 5`) degrades to `[]` — no include/exclude patterns — with no notice at all:** this is the one form in this table that is silently dropped rather than disclosed. |
| `instructions[i].agent` / `instructions[i].reference` | Optional strings. | Not validated at all — whatever is present is used verbatim, string or not; no notice either way. |
| `verify` | Omitted, `null`, a single string, or an array of strings. | A non-string element inside the array → `item-dropped` at `verify[i]`. **Present but neither `null`, a string, nor an array (e.g. `"verify": 5`, `"verify": true`, `"verify": {}`) → `verify-type-invalid` at `verify` — and this is *not* an opt-out.** It falls through to autodetection exactly as if the key were absent: the resolved command list comes from `package.json`/`Makefile` instead, and the human sees that autodetected list at the consent gate (`SKILL.md` Step 6) with the `verify-type-invalid` notice attached alongside it. Reporting a type error as "opted-out" would tell the reader the repo *declined* verification when it actually wrote something invalid — two different facts the notice keeps apart. |
| `disableDefaultLenses` | Omitted, `null`, a single string, or an array of strings. | A non-string element inside the array → `item-dropped` at `disableDefaultLenses[i]`. A whole-value type error degrades to `[]` — no notice — same as `fileFilters` above, but for a deliberately different reason: dropping this key's value entirely means *no* base lens gets disabled, which is the safe direction (more review, not less), so unlike `verify` it needs no `-type-invalid` counterpart to warn about silently opting out of something. |
| any string inside an array-of-strings value (`verify`, `disableDefaultLenses`, `fileFilters`) | A non-empty (after trimming) string. | An empty or whitespace-only string is dropped silently, the same as if it were never written — this is normal, accepted input, not a malformed form; noted here only so it isn't mistaken for a missed `item-dropped` case. |

## 2. How `build-context.mjs` turns this into lenses

1. `loadCustomInstructions()` parses the JSON and, per group, splits
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
5. If `REVIEW.json` doesn't exist, and there's no leftover `REVIEW.yaml`
   either, `loadCustomInstructions()` returns `[]` with no notices: no
   custom lenses run that iteration, only the base lenses do, and there is
   nothing to disclose. If the file exists but fails to parse, or a leftover
   `REVIEW.yaml` exists in its place, the lens list is still `[]`, but now
   accompanied by a notice (`parse-error`/`shape-invalid`, or
   `yaml-unsupported`) rather than being silent about it — see §1a above for
   the full table of malformed forms.

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

- `<name>` — the exact lens name (the JSON group's `name`, unchanged —
  matches the `lens` field and the `lenses` object key from
  `build-context.mjs`).
- `<paraphrase>` — a short, few-word restatement of *which* directive
  within the group's `instructions` block justifies this specific finding.
  Since a group's `instructions` can bundle multiple rules, the paraphrase
  lets a human reading the report see which one applied without opening
  the JSON file.
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

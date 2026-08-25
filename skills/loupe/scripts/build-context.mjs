#!/usr/bin/env node
// build-context.mjs — deterministic review-context builder for the `loupe` skill.
// Parses `git diff base..HEAD`, excludes generated files, matches this repo's own
// REVIEW.json custom rules to the changed files, and emits per-lens, LLM-facing
// context (diff parsing, generated-file exclusion, custom-instruction matching,
// tagged-diff formatting) — no API calls or prompt rendering here; those are
// handled by Claude subagents.

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

export function parseDiff(raw) {
  const files = []
  for (const section of raw.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue
    const oldPath = section.match(/^--- (?:a\/(.+)|\/dev\/null)$/m)?.[1]
      ?? section.match(/^rename from (.+)$/m)?.[1] ?? null
    const newPath = section.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/m)?.[1]
      ?? section.match(/^rename to (.+)$/m)?.[1] ?? null
    const binary = /^Binary files |^GIT binary patch/m.test(section)
    const hunkStart = section.search(/^@@ /m)
    files.push({
      oldPath, newPath,
      path: newPath ?? oldPath,
      newFile: /^new file mode /m.test(section),
      renamed: /^rename from /m.test(section),
      binary,
      diff: binary || hunkStart < 0 ? "" : section.slice(hunkStart),
    })
  }
  return files
}

export function parseGeneratedAttrs(out) {
  const set = new Set()
  // Standard git attributes for marking generated files: linguist-generated (GitHub/Linguist)
  // and gitlab-generated (GitLab). Both are forge-agnostic conventions; we use them to exclude
  // auto-generated files from review (not a product dependency).
  for (const line of (out ?? "").split("\n")) {
    const m = line.match(/^(.*): (?:gitlab-generated|linguist-generated): (set|true)$/)
    if (m) set.add(m[1])
  }
  return set
}

// Built-in generated-file exclusions — independent of whatever the reviewed
// repo's own .gitattributes marks (parseGeneratedAttrs above). That mechanism
// only returns anything when a repo ships a .gitattributes saying so, and most
// don't; a live run against a repo with none put a lockfile's full diff plus
// its pre-image (tens of KB no lens can say anything useful about) straight
// into every lens' payload. Kept deliberately small and unambiguous: wrongly
// excluding real source is a much worse failure than reviewing a lockfile — it
// would leave the report silently not covering a file the human believes was
// reviewed. No directory conventions here (dist/, build/, vendor/, ...): those
// are conventions, not guarantees, and some repos genuinely keep source there.
const GENERATED_LOCKFILES = new Set([
  // JS/TS package managers: one lockfile format per manager, always machine-written.
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  // Other ecosystems' equivalents — same machine-written, never-hand-edited contract.
  "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum",
])

// Minified/derived build output: always regenerated from an unminified
// sibling that itself remains subject to review, so the derived file itself
// carries nothing a lens could usefully comment on.
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map"]

// Matches a changed-file path against the built-in list above. Lockfiles match
// on the bare basename so a workspace package's own lockfile counts the same
// as one at the repo root; suffix patterns are checked against the basename
// only (never the full path) so a directory segment can't accidentally supply
// the match. `endsWith`, not `includes`: a file that merely contains ".min.js"
// without ending in it (e.g. "src/min.jsx", "notmin.js.ts") is real source.
export function isBuiltinGenerated(path) {
  const basename = path.split("/").pop()
  if (GENERATED_LOCKFILES.has(basename)) return true
  return GENERATED_SUFFIXES.some((suf) => basename.endsWith(suf))
}

// Unions the repo's own git-attribute-based exclusions with the built-in list:
// a path is generated when *either* source says so. Attributes stay
// authoritative for whatever they cover — this never removes a path attrs
// added — the built-in list only adds the specific, unambiguous class of file
// every repo has one of but few remember to mark, whether or not
// .gitattributes exists at all.
export function markGenerated(paths, attrGenerated) {
  const set = new Set(attrGenerated)
  for (const path of paths) if (isBuiltinGenerated(path)) set.add(path)
  return set
}

export function fnmatch(name, pat) {
  let re = ""
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === "*" && pat[i + 1] === "*") {
      // Handle ** specially - matches zero or more path levels
      if (pat[i + 2] === "/") {
        // **/ matches zero or more directory levels followed by /
        re += "(?:.*/)?"
        i += 2  // Skip the second * and /
      } else {
        // ** at end or followed by non-slash
        re += ".*"
        i += 1  // Skip the second *
      }
    } else if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      let j = i + 1
      if (pat[j] === "!") j++
      if (pat[j] === "]") j++
      while (j < pat.length && pat[j] !== "]") j++
      if (j >= pat.length) { re += "\\[" } else {
        let stuff = pat.slice(i + 1, j)
        if (stuff[0] === "!") stuff = "^" + stuff.slice(1)
        re += `[${stuff}]`
        i = j
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  try { return new RegExp(`^(?:${re})$`).test(name) } catch { return false }
}

export function matchesInstruction(path, ins) {
  const inc = !ins.include_patterns.length || ins.include_patterns.some((p) => fnmatch(path, p))
  const exc = ins.exclude_patterns.some((p) => fnmatch(path, p))
  return inc && !exc
}

// parseConfig(text) parses a REVIEW.json/default.json-shaped JSON config into
// { config, notices }. This is the one place that decides whether a piece of
// the config is usable — the loader that discovers a problem is the loader
// that reports it, rather than a separate detector re-deriving the same
// reject predicate later (that duplication is exactly what this migration
// removes). `config` always has the shape `{ instructions, verify,
// disableDefaultLenses }`, even when nothing parsed — `instructions: []`,
// `verify: { items: [], present: false }`, `disableDefaultLenses: []` — so a
// caller never has to branch on whether parsing succeeded before reading a
// key off the result.
//
// `notices` is a flat array of `{ path, reason }`. `path` locates the
// problem: a position inside the parsed config (e.g. `"instructions[2]"`,
// `"verify[0]"`) for anything parseConfig itself found while walking the
// config, or the empty string `""` for a whole-file problem with no such
// position. `reason` is one of exactly these five values, defined here and
// nowhere else:
//
//   yaml-unsupported     the repo has a REVIEW.yaml and no REVIEW.json. Never
//                         produced by parseConfig itself — it only ever sees
//                         the text of a file that exists. The caller that
//                         resolves the path (loadReviewConfig below) emits
//                         this when it finds that condition instead.
//   parse-error           the file exists but `JSON.parse` threw (including
//                         an empty file, which throws the same way).
//   shape-invalid         parsed, but the top level is not an object, or
//                         `instructions` is present and not an array.
//   item-dropped          an individual lens or list element was rejected.
//   verify-type-invalid   `verify` is present but is neither a string, an
//                         array, nor `null`.
//   config-absent-from-base  the base revision has no config, so the working
//                         tree's was used. Never produced by parseConfig —
//                         loadReviewConfig emits it when it resolves the text.
//   config-differs-from-base  the working tree's config differs from the base
//                         revision's. The base one was used. Also emitted by
//                         loadReviewConfig, for the same reason.
export function parseConfig(text) {
  const empty = { instructions: [], verify: { items: [], present: false }, disableDefaultLenses: [] }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { config: empty, notices: [{ path: "", reason: "parse-error" }] }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: empty, notices: [{ path: "", reason: "shape-invalid" }] }
  }

  const notices = []

  // `instructions` — an element is dropped when `name` or `instructions` is
  // not a non-empty string. The type is checked before `.trim()` is called on
  // either: a JSON value can legally be a number, a boolean, or an object
  // where a YAML capture group could not, so `{"instructions": 5}` must be
  // rejected by type, not by calling a string method on it and throwing.
  let instructions = []
  if ("instructions" in parsed) {
    if (!Array.isArray(parsed.instructions)) {
      notices.push({ path: "instructions", reason: "shape-invalid" })
    } else {
      instructions = parsed.instructions.flatMap((item, i) => {
        if (
          item === null || typeof item !== "object" || Array.isArray(item) ||
          typeof item.name !== "string" || item.name.trim() === "" ||
          typeof item.instructions !== "string" || item.instructions.trim() === ""
        ) {
          notices.push({ path: `instructions[${i}]`, reason: "item-dropped" })
          return []
        }
        const { items: fileFilters, notices: filterNotices } = normalizeList(item.fileFilters)
        for (const n of filterNotices) notices.push({ path: `instructions[${i}].fileFilters${n.path}`, reason: n.reason })
        return [{ name: item.name, agent: item.agent, reference: item.reference, instructions: item.instructions, fileFilters }]
      })
    }
  }

  // `verify` — a value that isn't `null`, a string, or an array is a type
  // error (`verify-type-invalid`), never silently read as an opt-out: `5` is
  // a mistake, not a decision to skip verification, and reporting it as
  // `opted-out` would tell a human the repo declined verification when it
  // actually wrote something invalid.
  let verify = { items: [], present: false }
  if ("verify" in parsed) {
    const v = parsed.verify
    if (v === null || typeof v === "string" || Array.isArray(v)) {
      const { items, notices: verifyNotices } = normalizeList(v)
      verify = { items, present: true }
      for (const n of verifyNotices) notices.push({ path: `verify${n.path}`, reason: n.reason })
    } else {
      notices.push({ path: "verify", reason: "verify-type-invalid" })
      verify = { items: [], present: true }
    }
  }

  // `disableDefaultLenses` — same normalization as `verify`, but the
  // fail-safe direction is the OPPOSITE of `verify`'s: dropping an entry here
  // means that base lens is NOT disabled, i.e. *more* review runs, which is
  // the safe direction. That's why there is no `disableDefaultLenses`
  // equivalent of `verify-type-invalid` below — a wholly wrong-typed value
  // degrades to "disable nothing" with no notice, never to "skip a lens the
  // repo didn't actually ask to skip". Do not copy verify's stricter handling
  // here later; the two keys fail in opposite directions on purpose.
  let disableDefaultLenses = []
  if ("disableDefaultLenses" in parsed) {
    const { items, notices: disableNotices } = normalizeList(parsed.disableDefaultLenses)
    disableDefaultLenses = items
    for (const n of disableNotices) notices.push({ path: `disableDefaultLenses${n.path}`, reason: n.reason })
  }

  return { config: { instructions, verify, disableDefaultLenses }, notices }
}

// Normalizes a config value that is expected to be a list of strings:
// `null`/absent → `[]`; a bare string → a one-item list (dropped to `[]` if
// it's empty/whitespace-only); an array → its string elements, with a
// trimmed-empty string silently dropped (same as absent — "" is not a
// runnable command or a real lens name) and any non-string element dropped
// with an `item-dropped` notice at that index; anything else (the value is
// wholly the wrong type) → `[]` with no notice — whether a whole-value type
// error deserves its own notice is the caller's call, not this function's
// (`verify` wants one, `disableDefaultLenses` deliberately does not; see
// parseConfig above).
export function normalizeList(value) {
  if (value == null) return { items: [], notices: [] }
  if (typeof value === "string") return { items: value.trim() ? [value] : [], notices: [] }
  if (Array.isArray(value)) {
    const items = []
    const notices = []
    value.forEach((v, i) => {
      if (typeof v === "string") { if (v.trim()) items.push(v) }
      else notices.push({ path: `[${i}]`, reason: "item-dropped" })
    })
    return { items, notices }
  }
  return { items: [], notices: [] }
}

// Normalizes a parsed config item into a lens definition. `fileFilters` split into
// include/exclude (a leading `!` marks an exclude); `agent` defaults to code-reviewer.
function toLensDef(i, type) {
  return {
    name: i.name,
    type,
    agent: i.agent || "code-reviewer",
    reference: i.reference,
    instructions: i.instructions,
    include_patterns: i.fileFilters.filter((f) => !f.startsWith("!")),
    exclude_patterns: i.fileFilters.filter((f) => f.startsWith("!")).map((f) => f.slice(1)),
  }
}

// Reads and parses the reviewed repo's own REVIEW.json, if it has one.
// Shared by the three independent readers of that file below
// (loadCustomInstructions, loadDisabledLenses, and the verify-resolution
// branch of detectVerifyCommands) so the "does this repo even have a config,
// and is it the current file name" check lives in one place rather than
// three. Each of those three still calls this — and therefore parseConfig —
// separately, once per key it cares about; main() is what deduplicates the
// resulting notices afterwards (see its own comment).
//
// `rev`, when given, is the revision the config is read FROM — the merge-base,
// passed down by main(). This is not a detail: the config decides how the review
// runs. Its custom lenses reach the reviewer and the judge verbatim, its
// `disableDefaultLenses` can switch a built-in lens off, and its `verify` list is
// executed. Reading it out of the working tree therefore lets the branch under
// review rewrite the reviewer that is about to review it, and two of those three
// take effect with no prompt anywhere. Reading it from the base revision means a
// branch can propose a config change and a human can see it, which is what
// reviewing a config change is supposed to look like.
//
// Two cases keep the working tree's copy, both reported rather than silent:
// the base has no config at all (a repo adopting one for the first time — the
// alternative is a tool that does nothing the first time it is used), and `rev`
// is absent, which is `--all` (no base exists to read, and that mode already
// says to run it only on a repo you trust).
function loadReviewConfig(repo, deps, rev = null) {
  const empty = { instructions: [], verify: { items: [], present: false }, disableDefaultLenses: [] }
  const file = join(repo, "REVIEW.json")
  const onDisk = deps.existsSync(file) ? deps.readFileSync(file, "utf8") : null
  const atBase = rev && deps.showAtRev ? deps.showAtRev(`${rev}:REVIEW.json`) : null

  if (atBase != null) {
    const notices = onDisk != null && onDisk !== atBase
      ? [{ path: "REVIEW.json", reason: "config-differs-from-base" }]
      : []
    const parsed = parseConfig(atBase)
    return { config: parsed.config, notices: [...notices, ...parsed.notices] }
  }

  if (onDisk == null) {
    // A leftover REVIEW.yaml from before this migration is not read at all —
    // this is the one legitimate surviving reference to that filename, and it
    // exists to tell a repo it has one, not to parse it.
    if (deps.existsSync(join(repo, "REVIEW.yaml"))) {
      return { config: empty, notices: [{ path: "REVIEW.yaml", reason: "yaml-unsupported" }] }
    }
    return { config: empty, notices: [] }
  }

  const parsed = parseConfig(onDisk)
  const notices = rev ? [{ path: "REVIEW.json", reason: "config-absent-from-base" }] : []
  return { config: parsed.config, notices: [...notices, ...parsed.notices] }
}

// Bundled default lenses (correctness/security/performance/maintainability/
// devops), shipped in rules/default.json next to this skill. Same JSON schema
// as a repo's own REVIEW.json, plus optional `agent` (which reviewer runs the
// lens) and `reference` (its section in references/review-lenses.md). Tagged
// type "base".
//
// Throws when the bundled file is missing, or when it parses to something
// unusable (`parse-error`/`shape-invalid`) — this file ships with the skill
// and is never user-supplied, so either condition is a packaging defect, not
// something to degrade past silently: shipping zero base lenses while every
// existing test still passes is exactly the failure this migration cannot
// afford. `process.exit` belongs to `main()`, not here — this function is
// also called directly by tests, and exiting the process here would kill the
// test runner along with the `deps` injection seam.
export function loadDefaultLenses(deps = { readFileSync, existsSync }) {
  const file = fileURLToPath(new URL("../rules/default.json", import.meta.url))
  if (!deps.existsSync(file)) throw new Error("default lenses not found at rules/default.json")
  const { config, notices } = parseConfig(deps.readFileSync(file, "utf8"))
  if (notices.some((n) => n.reason === "parse-error" || n.reason === "shape-invalid")) {
    throw new Error("bundled rules/default.json failed to parse")
  }
  return { lenses: config.instructions.map((i) => toLensDef(i, "base")), notices }
}

// Per-repo custom lenses from the reviewed repo's own REVIEW.json. Tagged
// type "custom".
export function loadCustomInstructions(repo, deps = { readFileSync, existsSync }, rev = null) {
  const { config, notices } = loadReviewConfig(repo, deps, rev)
  return { lenses: config.instructions.map((i) => toLensDef(i, "custom")), notices }
}

// The optional top-level `disableDefaultLenses` key: base-lens names the repo
// wants turned off entirely. Names are matched case-insensitively in main().
export function loadDisabledLenses(repo, deps = { readFileSync, existsSync }, rev = null) {
  const { config, notices } = loadReviewConfig(repo, deps, rev)
  return { names: config.disableDefaultLenses, notices }
}

// Verification command groups, ordered cheapest-and-most-local first so the
// orchestrator's run surfaces a type error before spending a full test suite on
// it. At most one command is taken per group (the first name present).
const VERIFY_GROUPS = [["typecheck", "type-check", "tsc"], ["lint"], ["test"]]

// The group scan, shared by every autodetection source: `recognizes` decides
// whether that source offers a given name. Returns the winning name per group
// (at most one per group, first name present) — turning a name into a
// runnable command, and (package.json only) into script bodies for
// disclosure, is left to the caller. Adding a source (Justfile, Cargo, a
// workspace root) means supplying `recognizes`, not copying the walk.
function pickVerifyNames(recognizes) {
  const names = []
  for (const group of VERIFY_GROUPS) {
    const hit = group.find(recognizes)
    if (hit) names.push(hit)
  }
  return names
}

function detectPackageManager(repo, deps) {
  const locks = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"]]
  for (const [file, pm] of locks) if (deps.existsSync(join(repo, file))) return pm
  return "npm"
}

// Collects rule targets from a Makefile: `name:` at column 0, excluding `name:=`
// style variable assignments. Only whitelisted names are ever used as commands.
export function parseMakefileTargets(text) {
  const out = new Set()
  for (const raw of text.split("\n")) {
    const m = raw.replace(/\r$/, "").match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/)
    if (m) out.add(m[1])
  }
  return out
}

// Resolves the verification commands for a repo. An explicit top-level `verify`
// key in REVIEW.json wins over autodetection; otherwise commands are
// autodetected from the repo's own package.json scripts or Makefile targets,
// restricted to VERIFY_GROUPS.
//
// THE RETURNED SHAPE — this comment is the single definition of these fields'
// legal values. SKILL.md and output-format.md point here instead of restating
// them, so the value sets cannot drift between files:
//
//   commands      Shell command strings, in run order. May be empty.
//   source        Where the list came from — PROVENANCE ONLY, never a reason:
//                 "REVIEW.json" | "package.json" | "Makefile" | null.
//                 The orchestrator may substitute an object whose source is
//                 "--verify" when the caller passed that argument; this
//                 function never emits that value.
//   skipped       Why there is nothing to run, or null when there is something:
//                 "all-mode"     — under --all nothing the repo supplies is
//                                  resolved at all
//                 "opted-out"    — the repo wrote a `verify` key resolving to
//                                  no commands, i.e. "do not verify"
//                 "not-detected" — no usable `verify` key and no recognized
//                                  script (this also covers a `verify` key
//                                  that failed to parse as a list at all —
//                                  see `notices` below — so a type error
//                                  never gets mistaken for "opted-out")
//                 The two are independent: an opt-out has a real provenance
//                 ("REVIEW.json") *and* a skip reason.
//   repoSupplied  True when the list was read off the reviewed repo's disk. The
//                 whitelist constrains the script *name*, never the body that
//                 runs, so `npm run test` executes whatever that repo wrote,
//                 and a `verify` entry is an unfiltered shell string. This is
//                 the flag the orchestrator's consent gate tests: this function
//                 resolves candidates, it never authorizes them.
//                 It is provenance and nothing else. Two readings the name
//                 invites are both wrong, and each would weaken the gate:
//                 it does **not** mean the repo asked to be verified — an
//                 autodetected `package.json` script is a script that happens
//                 to exist, not a request — and it does **not** mean there is
//                 something to run, since `verify: []` sets it true with an
//                 empty list. "Is what we are about to execute controlled by
//                 the reviewed repo" is the whole question it answers.
//   bodies        Present only when source is "package.json": one entry per
//                 whitelisted command's own script body, plus the
//                 `pre<name>`/`post<name>` hooks npm's model defines, where the
//                 repo defines them — `npm run <name>` executes those too,
//                 invisibly to the name alone. Keyed by script name, e.g.
//                 { test: "node --test", pretest: "node ./setup.js" }.
//                 The hook set is npm's, but `commands` may say pnpm, yarn or
//                 bun: whether a given manager runs pre/post at all differs by
//                 manager, by major version, and in at least one case by a
//                 config key, and this function resolves none of that. It
//                 collects them regardless, because the two error directions
//                 are not symmetric — printing a hook that turns out not to
//                 run tells a human more than they needed, while omitting one
//                 that does run is precisely the surprise the gate exists to
//                 prevent. Not covered either way: a manager running some hook
//                 npm has no name for. This is disclosure data for the consent
//                 gate to print (SKILL.md Step 6) — never a trust input;
//                 nothing decides anything from it.
//   makefile      Present only when source is "Makefile": the resolved file's
//                 path relative to `repo`, e.g. "GNUmakefile" — one of
//                 "GNUmakefile" | "makefile" | "Makefile", whichever this repo's
//                 own resolution order (matching GNU make's) picked. Disclosure
//                 data: the consent gate must read *this* file's target recipe,
//                 not assume a name, since a repo can ship more than one and
//                 `make` only reads the first in that order.
//   notices       This call's view of parseConfig's notices for this repo's
//                 REVIEW.json (or the single `yaml-unsupported` notice when
//                 there's a REVIEW.yaml and no REVIEW.json instead) — always
//                 present, `[]` when there is nothing to report. Reading
//                 REVIEW.json for `verify` also parses `instructions` and
//                 `disableDefaultLenses`, so this can include notices that
//                 have nothing to do with verification; main() is what
//                 collects and deduplicates every loader's notices into the
//                 single `configNotices` field on its own output (see that
//                 comment). Always `[]` under --all, which does not read the
//                 repo's REVIEW.json at all.
//
// Nothing the repo supplies is resolved under `--all`, its own `verify` list
// included; only the caller's own `--verify` enables the gate there. The
// rationale for that lives in SKILL.md's safety rules, not here.
export function detectVerifyCommands(repo, { all = false, rev = null } = {}, deps = { readFileSync, existsSync }) {
  if (all) return { commands: [], source: null, skipped: "all-mode", repoSupplied: false, notices: [] }

  const { config, notices } = loadReviewConfig(repo, deps, rev)
  // `present` alone can't tell a real (if empty) `verify` list apart from a
  // `verify-type-invalid` one — parseConfig's `{ items, present }` shape is
  // identical for both (see its own comment). A type error must not resolve
  // to "opted-out": that would tell a human the repo declined verification
  // when it actually wrote something invalid. So a type-invalid `verify` is
  // treated as unusable here and falls through to autodetection below, same
  // as if the key were absent — the problem itself is still surfaced via
  // `notices`, just never silently relabeled as a deliberate opt-out.
  const verifyTypeInvalid = notices.some((n) => n.path === "verify" && n.reason === "verify-type-invalid")
  if (config.verify.present && !verifyTypeInvalid) {
    // Key presence, not list length, decides. A repo that writes `verify: []`
    // is opting out, and the single-command shorthand `verify: "npm test"` is
    // opting in to exactly that one command; falling through to autodetection
    // in either case would run commands the repo didn't ask for, or skip the
    // one command it did.
    return {
      commands: config.verify.items,
      source: "REVIEW.json",
      skipped: config.verify.items.length ? null : "opted-out",
      repoSupplied: true,
      notices,
    }
  }

  const pkgPath = join(repo, "package.json")
  if (deps.existsSync(pkgPath)) {
    let scripts = {}
    try { scripts = JSON.parse(deps.readFileSync(pkgPath, "utf8")).scripts ?? {} } catch { scripts = {} }
    const pm = detectPackageManager(repo, deps)
    const names = pickVerifyNames((n) => typeof scripts[n] === "string" && Boolean(scripts[n].trim()))
    const commands = names.map((n) => `${pm} run ${n}`)
    // Disclosure only — the whitelist predicate above never inspects
    // `pre`/`post` hooks, but the resolved `${pm} run <n>` may execute them
    // anyway, so the consent gate needs these bodies to show what can actually
    // run, not just the whitelisted name. Collected on npm's hook naming for
    // every manager; the shape comment above says why, and what that does and
    // doesn't cover.
    const bodies = Object.fromEntries(
      names.flatMap((n) => [`pre${n}`, n, `post${n}`]
        .filter((k) => typeof scripts[k] === "string")
        .map((k) => [k, scripts[k]])),
    )
    if (commands.length) return { commands, bodies, source: "package.json", skipped: null, repoSupplied: true, notices }
  }

  // Order matters and is load-bearing: this must match GNU make's own resolution
  // order (GNUmakefile, then makefile, then Makefile). If a repo ships more than
  // one, `make` reads whichever comes first in *its* order — scanning them in any
  // other order here can resolve targets from a file `make` will never read,
  // silently defeating the consent gate that shows a human the resolved file's
  // recipe before authorizing it (SKILL.md Step 6).
  const makefileRel = ["GNUmakefile", "makefile", "Makefile"].find((f) => deps.existsSync(join(repo, f)))
  const makefile = makefileRel ? join(repo, makefileRel) : undefined
  if (makefile) {
    let targets = new Set()
    try { targets = parseMakefileTargets(deps.readFileSync(makefile, "utf8")) } catch { targets = new Set() }
    const commands = pickVerifyNames((n) => targets.has(n)).map((n) => `make ${n}`)
    if (commands.length) return { commands, source: "Makefile", makefile: makefileRel, skipped: null, repoSupplied: true, notices }
  }
  return { commands: [], source: null, skipped: "not-detected", repoSupplied: false, notices }
}

// Diff line content is passed through raw (not HTML-escaped) because the consumer
// is an LLM reading tagged context, not a browser.
export function formatDiffLines(rawDiff) {
  if (!rawDiff.trim() || rawDiff.includes("Binary files")) return ""
  const lines = []
  let lineOld = 1, lineNew = 1
  for (const line of rawDiff.split("\n")) {
    if (!line) continue
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) { lineOld = Number(m[1]); lineNew = Number(m[2]); lines.push(`<chunk_header>${line}</chunk_header>`) }
      continue
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) continue
    if (line.startsWith("\\")) { lines.push(`<line type="nonewline" old_line="${lineOld}" new_line="${lineNew}">${line}</line>`); continue }
    if (line.startsWith("+")) { lines.push(`<line type="added" old_line="" new_line="${lineNew}">${line.slice(1)}</line>`); lineNew++ }
    else if (line.startsWith("-")) { lines.push(`<line type="deleted" old_line="${lineOld}" new_line="">${line.slice(1)}</line>`); lineOld++ }
    else if (line.startsWith(" ")) { lines.push(`<line type="context" old_line="${lineOld}" new_line="${lineNew}">${line.slice(1)}</line>`); lineOld++; lineNew++ }
    else { lines.push(`<line type="context" old_line="${lineOld}" new_line="${lineNew}">${line}</line>`); lineOld++; lineNew++ }
  }
  return lines.join("\n")
}

// Builds the per-lens context from a flat list of lens definitions (base first,
// then custom). A lens with no include patterns matches every reviewable file; a
// lens whose globs match nothing is skipped. Custom lenses are additive — to
// remove a base lens, filter it out before calling (see `disableDefaultLenses`
// in main()). Names should be distinct; an exact-name duplicate resolves to the
// later (custom) def by object-key order.
export function buildLenses(reviewable, filesContent, lensDefs) {
  const withOriginal = (f) => ({
    path: f.path,
    diff: f.diff,
    original: f.oldPath && !f.newFile ? (filesContent[f.oldPath] ?? null) : null,
  })
  const lenses = {}
  for (const def of lensDefs) {
    const matched = reviewable.filter((f) => matchesInstruction(f.path, def))
    if (!matched.length) continue
    lenses[def.name] = {
      type: def.type,
      agent: def.agent,
      reference: def.reference,
      instructions: def.instructions.trim(),
      include_patterns: def.include_patterns,
      exclude_patterns: def.exclude_patterns,
      files: matched.map(withOriginal),
    }
  }
  return lenses
}

// Merges notice arrays from every independent config reader into the single
// `configNotices` field main() prints, deduplicated by `{ path, reason }`:
// loadCustomInstructions, loadDisabledLenses and detectVerifyCommands each
// parse the repo's REVIEW.json separately (see loadReviewConfig), so the same
// problem in that one file surfaces once per reader — up to three times over
// — before this collapses it back to one.
function dedupeNotices(notices) {
  const seen = new Set()
  const out = []
  for (const n of notices) {
    const key = `${n.path} ${n.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

// THE TOP-LEVEL OUTPUT SHAPE — this comment is the single definition of the
// JSON object main() prints (both the early-return, no-reviewable-files case
// and the full path emit the same fields). SKILL.md and output-format.md point
// here instead of restating it, so the field set cannot drift between files:
//
//   base            The ref being diffed against ("(empty tree)" under --all).
//   mergeBase       The merge-base commit oid actually diffed from.
//   mode            "working-tree" (default) or "committed" (--committed).
//   all             Whether --all (whole-repo) mode was used.
//   changedFiles    Reviewable file paths, post generated-file exclusion.
//   renamed         { newPath: oldPath } for renamed files.
//   generated       Paths excluded as generated — the union of linguist/gitlab
//                   attributes and the built-in list (see markGenerated).
//   verify          detectVerifyCommands()'s result, minus its `notices` key
//                   (folded into configNotices below instead) — see its own
//                   comment for the rest of the shape.
//   configNotices   Every notice parseConfig produced while reading this
//                   repo's REVIEW.json (via loadCustomInstructions,
//                   loadDisabledLenses and detectVerifyCommands) and the
//                   bundled default.json (via loadDefaultLenses), merged and
//                   deduplicated by `{ path, reason }` — the same REVIEW.json
//                   gets parsed by three independent readers, so without
//                   dedup the same notice could appear up to three times.
//                   `[]` when nothing was dropped or invalid. See parseConfig's
//                   own comment for what `path` and `reason` mean.
//   disabledLenses  Base lens names this repo's own REVIEW.json
//                   `disableDefaultLenses` actually turned off — resolved
//                   against the real base-lens list, not merely echoing what
//                   the file requested, so a name that matches no base lens
//                   doesn't falsely claim one was disabled. Exists so a
//                   report can disclose that a lens (e.g. "security") never
//                   ran, rather than reading a report with zero findings
//                   from it as a clean pass.
//   shadowedLenses  Base lens names a same-named custom lens replaced instead
//                   of disabling — buildLenses resolves an exact-name
//                   collision by "last wins", so the repo's own custom
//                   instructions silently stand in for the base lens (e.g.
//                   "security") while the report would otherwise list that
//                   name as having run its built-in checklist. Always
//                   disjoint from disabledLenses: a name already removed by
//                   `disableDefaultLenses` can't also collide here.
//   lenses          buildLenses()'s result — see its own comment.
function main() {
  const argv = process.argv.slice(2)
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  const repo = flag("repo") ?? process.cwd()
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  const gitTry = (...a) => { try { return git(...a) } catch { return null } }

  if (gitTry("rev-parse", "--is-inside-work-tree") == null) {
    console.error(`loupe: ${repo} is not a git repository`); process.exit(1)
  }
  const all = argv.includes("--all")
  let base, mergeBase
  if (all) {
    // Review the entire repo: diff against the empty tree, so every tracked
    // file appears as newly added. The oid is computed, never hardcoded —
    // SHA-256 repos have a different empty-tree oid than SHA-1 ones. There's
    // no real base ref under --all, so --base (if passed) is ignored and
    // default-branch detection below is skipped entirely.
    base = "(empty tree)"
    mergeBase = git("hash-object", "-t", "tree", "/dev/null").trim()
  } else {
    base = flag("base")
    if (!base) {
      const head = gitTry("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
      base = head ? head.trim().replace("refs/remotes/origin/", "")
        : (gitTry("rev-parse", "--verify", "main") ? "main" : "master")
    }
    if (gitTry("rev-parse", "--verify", base) == null) {
      console.error(`loupe: cannot resolve base ref '${base}' (no origin/HEAD, main, or master; pass --base)`)
      process.exit(1)
    }
    const mergeBaseOut = gitTry("merge-base", base, "HEAD")
    if (mergeBaseOut == null) {
      console.error(`loupe: no common ancestor between '${base}' and HEAD (pass --base)`)
      process.exit(1)
    }
    mergeBase = mergeBaseOut.trim()
  }
  // Default: diff mergeBase against the WORKING TREE (committed + uncommitted tracked
  // changes) so work-in-progress is reviewed and the fix loop sees its own edits on the
  // next re-diff. `--committed` restores the commit-range diff (mergeBase..HEAD) for a
  // PR/MR-style gate on only what has been committed.
  const committed = argv.includes("--committed")
  // In working-tree mode, briefly mark untracked (new, unignored) files intent-to-add so
  // they appear in the diff as new files, then unstage them — the index is left as found.
  let intentToAdd = []
  if (!committed) {
    const untracked = (gitTry("ls-files", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean)
    if (untracked.length) { git("add", "-N", "--", ...untracked); intentToAdd = untracked }
  }
  let allDiffs
  try {
    allDiffs = parseDiff(git("diff", "-M", committed ? `${mergeBase}..HEAD` : mergeBase))
  } finally {
    if (intentToAdd.length) gitTry("reset", "-q", "HEAD", "--", ...intentToAdd)
  }
  const paths = allDiffs.map((f) => f.path).filter(Boolean)
  const attrGenerated = paths.length
    ? parseGeneratedAttrs(gitTry("check-attr", "gitlab-generated", "linguist-generated", "--", ...paths) ?? "")
    : new Set()
  const generated = markGenerated(paths, attrGenerated)
  const reviewable = allDiffs.filter((f) => f.diff.trim() && !generated.has(f.path))
  // Resolved on every invocation (cheap, idempotent) so the orchestrator's Step 7
  // never has to detect anything itself; `--all` suppresses autodetection.
  // The config is read from the merge-base, not from the working tree — see
  // loadReviewConfig. Under `--all` there is no base to read from, so `rev` stays null
  // and the working tree's copy is used, as that mode's own trust note says.
  const configRev = all ? null : mergeBase
  // Its own invocation rather than gitTry: a base revision that simply has no config is
  // the ordinary first-adoption case, and `git show` reports that on stderr, which would
  // otherwise print `fatal:` on a perfectly normal run.
  const showAtRev = (spec) => {
    try {
      return execFileSync("git", ["show", spec], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    } catch { return null }
  }
  const configDeps = { readFileSync, existsSync, showAtRev }
  const { notices: verifyNotices, ...verify } = detectVerifyCommands(repo, { all, rev: configRev }, configDeps)
  // Base lenses (bundled default.json) the repo disabled via `disableDefaultLenses`
  // (case-insensitive). Resolved before the early return below so `disabledLenses`
  // is still reported when nothing is reviewable — the repo disabled the lens
  // either way. Filtered against the real base-lens names (not merely echoing
  // what REVIEW.json requested) so a name that matches no base lens doesn't
  // falsely claim one was disabled.
  const { names: requestedDisabledNames, notices: disabledNotices } = loadDisabledLenses(repo, configDeps, configRev)
  const requestedDisabled = new Set(requestedDisabledNames.map((n) => n.toLowerCase()))
  let allBaseDefs, defaultNotices
  try {
    const loaded = loadDefaultLenses()
    allBaseDefs = loaded.lenses
    defaultNotices = loaded.notices
  } catch (err) {
    console.error(`loupe: ${err.message}`)
    process.exit(1)
  }
  const disabledLenses = allBaseDefs.filter((d) => requestedDisabled.has(d.name.toLowerCase())).map((d) => d.name)
  // Base lenses that survive disabling, but whose name a custom lens also
  // uses: buildLenses assigns `lenses[def.name]` per def in `lensDefs` order
  // (base first, then custom), so an exact-name collision has the custom def
  // silently replace the base one ("last wins") — not disabled, not
  // disclosed, unless reported here. Judged the same way buildLenses itself
  // resolves the collision: exact name-string match, not the case-insensitive
  // comparison disableDefaultLenses uses — a differently-cased custom name
  // does not actually collide as an object key. Resolved before the early
  // return below (like disabledLenses) so it's still reported when nothing is
  // reviewable, and always disjoint from disabledLenses since a disabled base
  // lens is filtered out of `baseDefs` before this compares.
  const baseDefs = allBaseDefs.filter((d) => !requestedDisabled.has(d.name.toLowerCase()))
  const { lenses: customDefs, notices: customNotices } = loadCustomInstructions(repo, configDeps, configRev)
  const customNames = new Set(customDefs.map((d) => d.name))
  const shadowedLenses = baseDefs.filter((d) => customNames.has(d.name)).map((d) => d.name)

  const configNotices = dedupeNotices([...defaultNotices, ...customNotices, ...disabledNotices, ...verifyNotices])
  for (const n of configNotices) console.error(`loupe: config notice: ${n.reason} at ${n.path || "(root)"}`)

  if (!reviewable.length) { console.log(JSON.stringify({ base, mergeBase, mode: committed ? "committed" : "working-tree", all, changedFiles: [], renamed: {}, generated: [...generated], verify, configNotices, disabledLenses, shadowedLenses, lenses: {} })); return }

  const filesContent = {}
  for (const f of reviewable) {
    if (!f.oldPath || f.newFile) continue
    const content = gitTry("show", `${mergeBase}:${f.oldPath}`)
    if (content == null || content.split("\n").length > 10000) continue
    filesContent[f.oldPath] = content
  }
  const renamed = Object.fromEntries(allDiffs.filter((f) => f.renamed).map((f) => [f.newPath, f.oldPath]))
  // Then the repo's own REVIEW.json — a same-named custom lens overrides its
  // base counterpart (buildLenses, last wins; see shadowedLenses above).
  const lensDefs = [...baseDefs, ...customDefs]

  // Pre-format the diff for each lens file so subagents receive the tagged form.
  const lenses = buildLenses(reviewable, filesContent, lensDefs)
  for (const lens of Object.values(lenses)) {
    for (const f of lens.files) f.diff = formatDiffLines(f.diff)
  }
  console.log(JSON.stringify({
    base, mergeBase, mode: committed ? "committed" : "working-tree", all,
    changedFiles: reviewable.map((f) => f.path),
    renamed, generated: [...generated], verify, configNotices, disabledLenses, shadowedLenses, lenses,
  }))
}

// Resolve process.argv[1] through symlinks (Node already resolves import.meta.url
// through them) and compare as canonical file URLs, so `main()` still runs when the
// script is invoked via a symlinked install path or a path with spaces / non-ASCII.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()

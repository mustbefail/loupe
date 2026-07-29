#!/usr/bin/env node
// build-context.mjs — deterministic review-context builder for the `loupe` skill.
// Parses `git diff base..HEAD`, excludes generated files, matches this repo's own
// REVIEW.yaml custom rules to the changed files, and emits per-lens, LLM-facing
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

function unquote(s) {
  const m = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/)
  return m ? m[1] : s.trim()
}

// Strips a trailing inline `# comment` from a scalar value: the `#` only starts
// a comment when it is preceded by whitespace and sits outside any quoted span.
// A `#` with no leading space, or one inside quotes, is left as literal text.
function stripInlineComment(s) {
  let inSingle = false, inDouble = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === "#" && !inSingle && !inDouble && i > 0 && /\s/.test(s[i - 1])) return s.slice(0, i)
  }
  return s
}

// Cleans a raw captured scalar: strip an inline comment, then unquote.
function clean(s) {
  return unquote(stripInlineComment(s).trim())
}

// Targeted parser for REVIEW.yaml: a top-level `instructions:` sequence of
// mappings, each with `name`, `fileFilters` (sequence) and `instructions`
// (block literal `|`). Not a general YAML parser.
export function parseInstructionsYaml(text) {
  const items = []
  let cur = null, mode = null, keyIndent = null, blockLines = null

  // The block ends when a non-blank line is indented at or below the
  // `instructions:` key itself, so a later line indented less than the
  // block's first content line (but still more than the key) is not lost.
  function flushBlock() {
    if (!cur || blockLines === null) return
    let minIndent = null
    for (const l of blockLines) {
      if (l.trim() === "") continue
      const indent = l.length - l.trimStart().length
      if (minIndent === null || indent < minIndent) minIndent = indent
    }
    if (minIndent === null) minIndent = 0
    cur.instructions = blockLines.map((l) => (l.trim() === "" ? "" : l.slice(minIndent))).join("\n") + "\n"
    blockLines = null
  }

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (mode === "instructions") {
      if (line.trim() === "") { blockLines.push(""); continue }
      const indent = line.length - line.trimStart().length
      if (indent > keyIndent) { blockLines.push(line); continue }
      flushBlock(); mode = null; keyIndent = null // block ends; reprocess this line below
    }
    const stripped = line.trim()
    if (stripped === "" || stripped.startsWith("#") || stripped === "---") continue
    const nameM = line.match(/^\s*-\s+name:\s*(.+?)\s*$/)
    if (nameM) { cur = { name: clean(nameM[1]), fileFilters: [], instructions: "" }; items.push(cur); mode = null; continue }
    if (!cur) continue
    const agentM = line.match(/^\s*agent:\s*(.+?)\s*$/)
    if (agentM) { cur.agent = clean(agentM[1]); mode = null; continue }
    const refM = line.match(/^\s*reference:\s*(.+?)\s*$/)
    if (refM) { cur.reference = clean(refM[1]); mode = null; continue }
    if (/^\s*fileFilters:\s*$/.test(line)) { mode = "fileFilters"; continue }
    const blockM = line.match(/^(\s*)instructions:\s*\|\s*$/)
    if (blockM) { mode = "instructions"; keyIndent = blockM[1].length; blockLines = []; continue }
    const inlineInstr = line.match(/^\s*instructions:\s*(.+?)\s*$/)
    if (inlineInstr) { cur.instructions = clean(inlineInstr[1]); mode = null; continue }
    if (mode === "fileFilters") {
      const fM = line.match(/^\s*-\s*(.+?)\s*$/)
      if (fM) cur.fileFilters.push(clean(fM[1]))
    }
  }
  flushBlock()
  // A lens needs a name and instructions; fileFilters are optional (absent = all files).
  return items.filter((i) => i.name && i.instructions.trim())
}

// Normalizes a parsed YAML item into a lens definition. `fileFilters` split into
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

// Bundled default lenses (correctness/security/performance/devops), shipped in
// rules/default.yaml next to this skill. Same YAML schema as a repo's REVIEW.yaml,
// plus optional `agent` (which reviewer runs the lens) and `reference` (its section
// in references/review-lenses.md). Tagged type "base".
export function loadDefaultLenses(deps = { readFileSync, existsSync }) {
  const file = fileURLToPath(new URL("../rules/default.yaml", import.meta.url))
  if (!deps.existsSync(file)) { console.error("loupe: default lenses not found at rules/default.yaml"); return [] }
  let parsed
  try { parsed = parseInstructionsYaml(deps.readFileSync(file, "utf8")) } catch { return [] }
  return parsed.map((i) => toLensDef(i, "base"))
}

// Per-repo custom lenses from the reviewed repo's own REVIEW.yaml. Tagged type "custom".
export function loadCustomInstructions(repo, deps = { readFileSync, existsSync }) {
  const file = join(repo, "REVIEW.yaml")
  if (!deps.existsSync(file)) return []
  let parsed
  try { parsed = parseInstructionsYaml(deps.readFileSync(file, "utf8")) } catch { return [] }
  return parsed.map((i) => toLensDef(i, "custom"))
}

// Reads a top-level `<key>:` list of scalars from REVIEW.yaml — either a block
// sequence or the inline `[a, b]` form. `key` is always a literal identifier
// here, so it needs no regex escaping. Block items may sit at any indent,
// including column 0 (`key:` then `- item`), which is valid YAML.
export function parseTopLevelList(text, key) {
  const out = []
  const inlineRe = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`)
  const blockRe = new RegExp(`^${key}:\\s*$`)
  let inList = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    const inline = line.match(inlineRe)
    if (inline) { for (const p of inline[1].split(",")) { const v = clean(p); if (v) out.push(v) } ; inList = false; continue }
    if (blockRe.test(line)) { inList = true; continue }
    if (inList) {
      // A document separator ends the list — it is not an item. Checked before
      // the item match because `---` otherwise satisfies it (dash + `--`) now
      // that items may sit at zero indent.
      if (line.trim() === "---") { inList = false; continue }
      const m = line.match(/^\s*-\s*(.+?)\s*$/)
      if (m) { out.push(clean(m[1])); continue }
      if (line.trim() === "" || line.trim().startsWith("#")) continue
      inList = false
    }
  }
  return out
}

// The optional top-level `disableDefaultLenses:` key: base-lens names the repo
// wants turned off entirely. Names are matched case-insensitively in main().
export function parseDisabledLenses(text) {
  return parseTopLevelList(text, "disableDefaultLenses")
}

// The optional top-level `verify:` key: shell commands loupe runs after a fix
// pass to catch regressions its own fixes introduced (SKILL.md Step 6.5).
export function parseVerifyCommands(text) {
  return parseTopLevelList(text, "verify")
}

export function loadDisabledLenses(repo, deps = { readFileSync, existsSync }) {
  const file = join(repo, "REVIEW.yaml")
  if (!deps.existsSync(file)) return []
  try { return parseDisabledLenses(deps.readFileSync(file, "utf8")) } catch { return [] }
}

// Verification command groups, ordered cheapest-and-most-local first so the
// orchestrator's run surfaces a type error before spending a full test suite on
// it. At most one command is taken per group (the first name present).
const VERIFY_GROUPS = [["typecheck", "type-check", "tsc"], ["lint"], ["test"]]

// The group scan, shared by every autodetection source: `recognizes` decides
// whether that source offers a given name, `prefix` turns the winning name into
// a runnable command. Adding a source (Justfile, Cargo, a workspace root) means
// supplying those two things, not copying the walk.
function pickVerifyCommands(recognizes, prefix) {
  const commands = []
  for (const group of VERIFY_GROUPS) {
    const hit = group.find(recognizes)
    if (hit) commands.push(prefix + hit)
  }
  return commands
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

// True when REVIEW.yaml declares a top-level `verify:` key at all, regardless of
// what it parses to. An empty list is a deliberate "do not verify" and must not
// be mistaken for an absent key, which is what enables autodetection.
function hasTopLevelKey(text, key) {
  return new RegExp(`^${key}:`, "m").test(text)
}

// Resolves the verification commands for a repo. An explicit top-level `verify:`
// list in REVIEW.yaml wins over autodetection; otherwise commands are
// autodetected from the repo's own package.json scripts or Makefile targets,
// restricted to VERIFY_GROUPS.
//
// THE RETURNED SHAPE — this comment is the single definition of these fields'
// legal values. SKILL.md and output-format.md point here instead of restating
// them, so the value sets cannot drift between files:
//
//   commands      Shell command strings, in run order. May be empty.
//   source        Where the list came from — PROVENANCE ONLY, never a reason:
//                 "REVIEW.yaml" | "package.json" | "Makefile" | null.
//                 The orchestrator may substitute an object whose source is
//                 "--verify" when the caller passed that argument; this
//                 function never emits that value.
//   skipped       Why there is nothing to run, or null when there is something:
//                 "all-mode"     — under --all nothing the repo supplies is
//                                  resolved at all
//                 "opted-out"    — the repo wrote a `verify:` key resolving to
//                                  no commands, i.e. "do not verify"
//                 "not-detected" — no `verify:` key and no recognized script
//                 The two are independent: an opt-out has a real provenance
//                 ("REVIEW.yaml") *and* a skip reason.
//   repoSupplied  True when the list was read off the reviewed repo's disk. The
//                 whitelist constrains the script *name*, never the body that
//                 runs, so `npm run test` executes whatever that repo wrote,
//                 and a `verify:` entry is an unfiltered shell string. This is
//                 the flag the orchestrator's consent gate tests: this function
//                 resolves candidates, it never authorizes them.
//
// Nothing the repo supplies is resolved under `--all`, its own `verify:` list
// included; only the caller's own `--verify` enables the gate there. The
// rationale for that lives in SKILL.md's safety rules, not here.
export function detectVerifyCommands(repo, { all = false } = {}, deps = { readFileSync, existsSync }) {
  if (all) return { commands: [], source: null, skipped: "all-mode", repoSupplied: false }

  const review = join(repo, "REVIEW.yaml")
  if (deps.existsSync(review)) {
    let text = "", explicit = []
    try { text = deps.readFileSync(review, "utf8"); explicit = parseVerifyCommands(text) } catch { text = ""; explicit = [] }
    // Key presence, not list length, decides. A repo that writes `verify: []`
    // is opting out; falling through to autodetection there would run commands
    // it explicitly declined — the opposite of what it asked for.
    if (explicit.length || hasTopLevelKey(text, "verify")) {
      return { commands: explicit, source: "REVIEW.yaml", skipped: explicit.length ? null : "opted-out", repoSupplied: true }
    }
  }

  const pkgPath = join(repo, "package.json")
  if (deps.existsSync(pkgPath)) {
    let scripts = {}
    try { scripts = JSON.parse(deps.readFileSync(pkgPath, "utf8")).scripts ?? {} } catch { scripts = {} }
    const pm = detectPackageManager(repo, deps)
    const commands = pickVerifyCommands((n) => typeof scripts[n] === "string" && Boolean(scripts[n].trim()), `${pm} run `)
    if (commands.length) return { commands, source: "package.json", skipped: null, repoSupplied: true }
  }

  const makefile = ["Makefile", "makefile", "GNUmakefile"].map((f) => join(repo, f)).find((p) => deps.existsSync(p))
  if (makefile) {
    let targets = new Set()
    try { targets = parseMakefileTargets(deps.readFileSync(makefile, "utf8")) } catch { targets = new Set() }
    const commands = pickVerifyCommands((n) => targets.has(n), "make ")
    if (commands.length) return { commands, source: "Makefile", skipped: null, repoSupplied: true }
  }
  return { commands: [], source: null, skipped: "not-detected", repoSupplied: false }
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
  const generated = paths.length
    ? parseGeneratedAttrs(gitTry("check-attr", "gitlab-generated", "linguist-generated", "--", ...paths) ?? "")
    : new Set()
  const reviewable = allDiffs.filter((f) => f.diff.trim() && !generated.has(f.path))
  // Resolved on every invocation (cheap, idempotent) so the orchestrator's Step 6.5
  // never has to detect anything itself; `--all` suppresses autodetection.
  const verify = detectVerifyCommands(repo, { all })
  if (!reviewable.length) { console.log(JSON.stringify({ base, mergeBase, mode: committed ? "committed" : "working-tree", all, changedFiles: [], renamed: {}, generated: [...generated], verify, lenses: {} })); return }

  const filesContent = {}
  for (const f of reviewable) {
    if (!f.oldPath || f.newFile) continue
    const content = gitTry("show", `${mergeBase}:${f.oldPath}`)
    if (content == null || content.split("\n").length > 10000) continue
    filesContent[f.oldPath] = content
  }
  const renamed = Object.fromEntries(allDiffs.filter((f) => f.renamed).map((f) => [f.newPath, f.oldPath]))
  // Base lenses (bundled default.yaml), minus any the repo disabled via
  // `disableDefaultLenses:` (case-insensitive), then the repo's own REVIEW.yaml.
  // A same-named custom lens overrides its base counterpart (buildLenses, last wins).
  const disabled = new Set(loadDisabledLenses(repo).map((n) => n.toLowerCase()))
  const baseDefs = loadDefaultLenses().filter((d) => !disabled.has(d.name.toLowerCase()))
  const lensDefs = [...baseDefs, ...loadCustomInstructions(repo)]

  // Pre-format the diff for each lens file so subagents receive the tagged form.
  const lenses = buildLenses(reviewable, filesContent, lensDefs)
  for (const lens of Object.values(lenses)) {
    for (const f of lens.files) f.diff = formatDiffLines(f.diff)
  }
  console.log(JSON.stringify({
    base, mergeBase, mode: committed ? "committed" : "working-tree", all,
    changedFiles: reviewable.map((f) => f.path),
    renamed, generated: [...generated], verify, lenses,
  }))
}

// Resolve process.argv[1] through symlinks (Node already resolves import.meta.url
// through them) and compare as canonical file URLs, so `main()` still runs when the
// script is invoked via a symlinked install path or a path with spaces / non-ASCII.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()

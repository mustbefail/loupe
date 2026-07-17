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

// Reads the optional top-level `disableDefaultLenses:` key from REVIEW.yaml —
// a list of base-lens names the repo wants turned off entirely (block sequence
// or inline `[a, b]` form). Names are matched case-insensitively in main().
export function parseDisabledLenses(text) {
  const out = []
  let inList = false
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    const inline = line.match(/^disableDefaultLenses:\s*\[(.*)\]\s*$/)
    if (inline) { for (const p of inline[1].split(",")) { const v = clean(p); if (v) out.push(v) } ; inList = false; continue }
    if (/^disableDefaultLenses:\s*$/.test(line)) { inList = true; continue }
    if (inList) {
      const m = line.match(/^\s+-\s*(.+?)\s*$/)
      if (m) { out.push(clean(m[1])); continue }
      if (line.trim() === "" || line.trim().startsWith("#")) continue
      inList = false
    }
  }
  return out
}

export function loadDisabledLenses(repo, deps = { readFileSync, existsSync }) {
  const file = join(repo, "REVIEW.yaml")
  if (!deps.existsSync(file)) return []
  try { return parseDisabledLenses(deps.readFileSync(file, "utf8")) } catch { return [] }
}

// Part of the context-formatting API retained for callers/tests, though main()'s
// per-lens path below doesn't invoke it.
export const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")

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

// Part of the context-formatting API retained for callers/tests, though main()'s
// per-lens path doesn't invoke it either.
export function formatCustomInstructions(instructions) {
  if (!instructions.length) return ""
  const items = instructions.map((ins) => {
    const inc = ins.include_patterns.join(", ") || "all files"
    const exc = ins.exclude_patterns.join(", ") || "none"
    return `For files matching "${inc}" (excluding: ${exc}) - ${ins.name}:\n${ins.instructions.trim()}\n`
  }).join("\n")
  return `<custom_instructions>\nApply these additional review instructions to matching files:\n\n${items}\n</custom_instructions>`
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
  let base = flag("base")
  if (!base) {
    const head = gitTry("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    base = head ? head.trim().replace("refs/remotes/origin/", "")
      : (gitTry("rev-parse", "--verify", "main") ? "main" : "master")
  }
  const mergeBase = git("merge-base", base, "HEAD").trim()
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
  const allDiffs = parseDiff(git("diff", "-M", committed ? `${mergeBase}..HEAD` : mergeBase))
  if (intentToAdd.length) gitTry("reset", "-q", "HEAD", "--", ...intentToAdd)
  const paths = allDiffs.map((f) => f.path).filter(Boolean)
  const generated = paths.length
    ? parseGeneratedAttrs(gitTry("check-attr", "gitlab-generated", "linguist-generated", "--", ...paths) ?? "")
    : new Set()
  const reviewable = allDiffs.filter((f) => f.diff.trim() && !generated.has(f.path))
  if (!reviewable.length) { console.log(JSON.stringify({ base, mergeBase, mode: committed ? "committed" : "working-tree", changedFiles: [], renamed: {}, generated: [...generated], lenses: {} })); return }

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
    base, mergeBase, mode: committed ? "committed" : "working-tree",
    changedFiles: reviewable.map((f) => f.path),
    renamed, generated: [...generated], lenses,
  }))
}

// Resolve process.argv[1] through symlinks (Node already resolves import.meta.url
// through them) and compare as canonical file URLs, so `main()` still runs when the
// script is invoked via a symlinked install path or a path with spaces / non-ASCII.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildLenses } from "../skills/loupe/scripts/build-context.mjs"

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "loupe", "scripts", "build-context.mjs")

test("buildLenses matches files to lens defs and skips zero-match lenses", () => {
  const reviewable = [
    { path: "app/user.rb", oldPath: "app/user.rb", diff: "@@ -1 +1 @@\n+x" },
    { path: "README.md", oldPath: "README.md", diff: "@@ -1 +1 @@\n+y" },
  ]
  const defs = [
    { name: "correctness", type: "base", agent: "code-reviewer", instructions: "c", include_patterns: [], exclude_patterns: [] },
    { name: "Ruby", type: "custom", agent: "code-reviewer", instructions: "Check N+1.", include_patterns: ["**/*.rb"], exclude_patterns: [] },
    { name: "PythonOnly", type: "custom", agent: "code-reviewer", instructions: "x", include_patterns: ["**/*.py"], exclude_patterns: [] },
  ]
  const lenses = buildLenses(reviewable, { "app/user.rb": "old" }, defs)
  assert.equal(lenses.correctness.files.length, 2) // no include patterns => covers all files
  assert.equal(lenses.correctness.type, "base")
  assert.deepEqual(lenses.Ruby.files.map((f) => f.path), ["app/user.rb"])
  assert.equal(lenses.Ruby.files[0].original, "old")
  assert.equal(lenses.Ruby.type, "custom")
  assert.equal(lenses.PythonOnly, undefined) // zero-match lens is skipped
})

test("buildLenses: a later (custom) def overrides a base def of the same name", () => {
  const reviewable = [{ path: "a.rb", oldPath: "a.rb", diff: "@@ -1 +1 @@\n+x" }]
  const defs = [
    { name: "security", type: "base", agent: "security-reviewer", instructions: "base sec", include_patterns: [], exclude_patterns: [] },
    { name: "security", type: "custom", agent: "code-reviewer", instructions: "custom sec", include_patterns: [], exclude_patterns: [] },
  ]
  const lenses = buildLenses(reviewable, {}, defs)
  assert.equal(lenses.security.type, "custom")
  assert.equal(lenses.security.instructions, "custom sec")
  assert.equal(lenses.security.agent, "code-reviewer")
})

test("CLI emits JSON with lenses for a real diff", () => {
  const repo = mkdtempSync(join(tmpdir(), "loupe-"))
  try {
    const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    writeFileSync(join(repo, "a.rb"), "puts 1\n"); g("add", "."); g("commit", "-qm", "base")
    const initBranch = g("branch", "--show-current").trim()
    g("checkout", "-qb", "feature")
    writeFileSync(join(repo, "REVIEW.yaml"), [
      "instructions:",
      "  - name: Ruby Quality",
      "    fileFilters:",
      '      - "**/*.rb"',
      "    instructions: |",
      "      Check for N+1 queries.",
      "",
    ].join("\n"))
    writeFileSync(join(repo, "a.rb"), "puts 2\n"); g("add", "."); g("commit", "-qam", "change")
    const out = execFileSync("node", [SCRIPT, "--base", initBranch, "--repo", repo], { encoding: "utf8" })
    const data = JSON.parse(out)
    assert.ok(data.changedFiles.includes("a.rb"))
    assert.ok(data.lenses.correctness.files.some((f) => f.path === "a.rb"))
    assert.ok(data.lenses["Ruby Quality"])
    assert.ok(data.lenses["Ruby Quality"].files.some((f) => f.path === "a.rb"))
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("default reviews uncommitted (tracked edits + new files); --committed does not", () => {
  const repo = mkdtempSync(join(tmpdir(), "loupe-"))
  try {
    const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    writeFileSync(join(repo, "committed.rb"), "puts 1\n")
    writeFileSync(join(repo, "wip.rb"), "puts 1\n")
    g("add", "."); g("commit", "-qm", "base")
    const initBranch = g("branch", "--show-current").trim()
    g("checkout", "-qb", "feature")
    writeFileSync(join(repo, "committed.rb"), "puts 2\n"); g("commit", "-qam", "committed change")
    writeFileSync(join(repo, "wip.rb"), "puts 99\n")          // uncommitted edit to a tracked file
    writeFileSync(join(repo, "fresh.rb"), "puts 3\n")         // brand-new untracked file
    const run = (...extra) => JSON.parse(execFileSync("node", [SCRIPT, "--base", initBranch, "--repo", repo, ...extra], { encoding: "utf8" }))

    const wt = run()
    assert.equal(wt.mode, "working-tree")
    assert.ok(wt.changedFiles.includes("committed.rb"))
    assert.ok(wt.changedFiles.includes("wip.rb"))            // uncommitted tracked edit picked up
    assert.ok(wt.changedFiles.includes("fresh.rb"))          // new untracked file picked up

    const committed = run("--committed")
    assert.equal(committed.mode, "committed")
    assert.ok(committed.changedFiles.includes("committed.rb"))
    assert.ok(!committed.changedFiles.includes("wip.rb"))    // uncommitted excluded
    assert.ok(!committed.changedFiles.includes("fresh.rb"))

    // the untracked probe must leave the index untouched (fresh.rb still untracked)
    assert.equal(g("status", "--porcelain", "fresh.rb").trim(), "?? fresh.rb")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

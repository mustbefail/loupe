import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildLenses } from "../skills/loupe/scripts/build-context.mjs"

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "loupe", "scripts", "build-context.mjs")

// Creates a throwaway git repo with identity configured, runs `fn(repo, g)`
// (`g` runs a git command in that repo), and guarantees cleanup even if `fn`
// throws. `options.initArgs` extends `git init -q` — e.g. `{ initArgs: ["-b",
// "trunk"] }` for a custom initial branch name.
function withTempRepo(options, fn) {
  if (typeof options === "function") { fn = options; options = {} }
  const repo = mkdtempSync(join(tmpdir(), "loupe-"))
  try {
    const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
    g("init", "-q", ...(options.initArgs ?? []))
    g("config", "user.email", "t@t")
    g("config", "user.name", "t")
    return fn(repo, g)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

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

test("CLI: disableDefaultLenses drops base lenses; custom lenses run in addition", () => {
  withTempRepo((repo, g) => {
    writeFileSync(join(repo, "Dockerfile"), "FROM node:20\n")
    g("add", "."); g("commit", "-qm", "base")
    const b = g("branch", "--show-current").trim()
    g("checkout", "-qb", "feat")
    writeFileSync(join(repo, "Dockerfile"), "FROM node:latest\n")
    writeFileSync(join(repo, "REVIEW.yaml"), [
      "disableDefaultLenses:",
      "  - performance",
      "  - devops",
      "instructions:",
      "  - name: DevOps",
      "    fileFilters:",
      '      - "*Dockerfile*"',
      "    instructions: |",
      "      Pin base images to a digest.",
      "",
    ].join("\n"))
    g("add", "."); g("commit", "-qam", "change")
    const data = JSON.parse(execFileSync("node", [SCRIPT, "--base", b, "--repo", repo], { encoding: "utf8" }))
    const keys = Object.keys(data.lenses)
    assert.ok(!keys.includes("performance"))   // disabled
    assert.ok(!keys.includes("devops"))        // disabled (we run our own DevOps lens instead)
    assert.ok(keys.includes("DevOps"))         // custom lens runs in addition
    assert.equal(data.lenses.DevOps.type, "custom")
    assert.ok(keys.includes("correctness") && keys.includes("security")) // other base lenses untouched
  })
})

test("CLI emits JSON with lenses for a real diff", () => {
  withTempRepo((repo, g) => {
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
  })
})

test("CLI: unresolvable base ref exits 1 with a clear error", () => {
  withTempRepo({ initArgs: ["-b", "trunk"] }, (repo, g) => {
    writeFileSync(join(repo, "a.rb"), "puts 1\n"); g("add", "."); g("commit", "-qm", "base")
    assert.throws(
      () => execFileSync("node", [SCRIPT, "--repo", repo], { encoding: "utf8" }),
      (err) => {
        assert.equal(err.status, 1)
        assert.match(err.stderr, /cannot resolve base ref/)
        return true
      },
    )
  })
})

test("--all reviews the entire repo via the empty-tree diff, even with no changes", () => {
  withTempRepo((repo, g) => {
    writeFileSync(join(repo, "a.rb"), "puts 1\n")
    writeFileSync(join(repo, "b.rb"), "puts 2\n")
    g("add", "."); g("commit", "-qm", "base")
    const branch = g("branch", "--show-current").trim()

    const noAll = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repo, "--base", branch], { encoding: "utf8" }))
    assert.deepEqual(noAll.changedFiles, [])
    assert.equal(noAll.all, false)

    const all = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repo, "--all"], { encoding: "utf8" }))
    assert.ok(all.changedFiles.includes("a.rb"))
    assert.ok(all.changedFiles.includes("b.rb"))
    assert.equal(all.all, true)
    assert.equal(all.base, "(empty tree)")
  })
})

test("CLI emits the resolved verify commands, and suppresses autodetection under --all", () => {
  withTempRepo((repo, g) => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } }))
    writeFileSync(join(repo, "a.rb"), "puts 1\n")
    g("add", "."); g("commit", "-qm", "base")
    const branch = g("branch", "--show-current").trim()
    g("checkout", "-qb", "feature")
    writeFileSync(join(repo, "a.rb"), "puts 2\n"); g("commit", "-qam", "change")

    const data = JSON.parse(execFileSync("node", [SCRIPT, "--base", branch, "--repo", repo], { encoding: "utf8" }))
    assert.equal(data.verify.source, "package.json")
    assert.deepEqual(data.verify.commands, ["npm run typecheck", "npm run test"])

    // --all points at repos nobody has vetted, so it must not autodetect a command to run.
    const all = JSON.parse(execFileSync("node", [SCRIPT, "--repo", repo, "--all"], { encoding: "utf8" }))
    assert.deepEqual(all.verify, { commands: [], source: "skipped-under-all" })
  })
})

test("default reviews uncommitted (tracked edits + new files); --committed does not", () => {
  withTempRepo((repo, g) => {
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
  })
})

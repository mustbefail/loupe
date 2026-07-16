import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildLenses } from "../scripts/build-context.mjs"

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "build-context.mjs")

test("buildLenses produces custom + base lenses over matched files", () => {
  const reviewable = [
    { path: "app/user.rb", oldPath: "app/user.rb", diff: "@@ -1 +1 @@\n+x" },
    { path: "README.md", oldPath: "README.md", diff: "@@ -1 +1 @@\n+y" },
  ]
  const custom = [{ name: "Ruby", instructions: "Check N+1.", include_patterns: ["**/*.rb"], exclude_patterns: [] }]
  const lenses = buildLenses(reviewable, { "app/user.rb": "old" }, custom)
  assert.deepEqual(lenses.Ruby.files.map((f) => f.path), ["app/user.rb"])
  assert.equal(lenses.Ruby.files[0].original, "old")
  assert.equal(lenses.correctness.files.length, 2) // base lens covers all
  assert.ok(lenses.security && lenses.performance)
})

test("CLI emits JSON with lenses for a real diff", () => {
  const repo = mkdtempSync(join(tmpdir(), "loupe-"))
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" })
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
  writeFileSync(join(repo, "a.rb"), "puts 1\n"); g("add", "."); g("commit", "-qm", "base")
  g("checkout", "-qb", "feature")
  writeFileSync(join(repo, "a.rb"), "puts 2\n"); g("commit", "-qam", "change")
  const out = execFileSync("node", [SCRIPT, "--base", "main", "--repo", repo], { encoding: "utf8" })
  const data = JSON.parse(out)
  assert.ok(data.changedFiles.includes("a.rb"))
  assert.ok(data.lenses.correctness.files.some((f) => f.path === "a.rb"))
  rmSync(repo, { recursive: true, force: true })
})

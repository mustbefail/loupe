import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDiff, fnmatch, matchesInstruction, parseGeneratedAttrs } from "../scripts/build-context.mjs"

test("parseDiff extracts added/modified/new/rename/binary records", () => {
  const raw = [
    "diff --git a/src/a.rb b/src/a.rb",
    "--- a/src/a.rb",
    "+++ b/src/a.rb",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " ctx",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/old.txt b/renamed.txt",
    "rename from old.txt",
    "rename to renamed.txt",
  ].join("\n")
  const files = parseDiff(raw)
  assert.equal(files.length, 3)
  assert.equal(files[0].path, "src/a.rb")
  assert.ok(files[0].diff.includes("@@ -1,2 +1,2 @@"))
  assert.equal(files[1].newFile, true)
  assert.equal(files[1].path, "new.txt")
  assert.equal(files[2].renamed, true)
  assert.equal(files[2].oldPath, "old.txt")
  assert.equal(files[2].newPath, "renamed.txt")
})

test("fnmatch matches Python semantics (star crosses slash)", () => {
  assert.equal(fnmatch("db/migrate/x.rb", "db/migrate/**/*.rb"), true)
  assert.equal(fnmatch("app/models/user.rb", "**/*.rb"), true)
  assert.equal(fnmatch("spec/models/user_spec.rb", "spec/**/*"), true)
  assert.equal(fnmatch("app/user.rb", "*.py"), false)
  assert.equal(fnmatch("user.rb", "**/*.rb"), true)   // leading ** matches a root-level file (zero directories)
  assert.equal(fnmatch("user.py", "**/*.rb"), false)  // wrong extension must not match
})

test("matchesInstruction honors include and exclude", () => {
  const ins = { include_patterns: ["**/*.rb"], exclude_patterns: ["spec/**/*"] }
  assert.equal(matchesInstruction("app/user.rb", ins), true)
  assert.equal(matchesInstruction("spec/user_spec.rb", ins), false)
  const all = { include_patterns: [], exclude_patterns: [] }
  assert.equal(matchesInstruction("anything.txt", all), true)
})

test("parseGeneratedAttrs collects set/true paths", () => {
  const out = "a.rb: gitlab-generated: set\nb.rb: linguist-generated: true\nc.rb: gitlab-generated: unset"
  const set = parseGeneratedAttrs(out)
  assert.ok(set.has("a.rb") && set.has("b.rb"))
  assert.equal(set.has("c.rb"), false)
})

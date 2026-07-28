import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDiff, fnmatch, matchesInstruction, parseGeneratedAttrs, parseMakefileTargets, detectVerifyCommands } from "../skills/loupe/scripts/build-context.mjs"

// Minimal fs stand-in keyed by absolute path, so verification detection can be
// tested without touching a real repo.
function fakeFs(files) {
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p)
  return {
    existsSync: has,
    readFileSync: (p) => { if (!has(p)) throw new Error(`ENOENT: ${p}`); return files[p] },
  }
}

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
  const out = "a.rb: linguist-generated: set\nb.rb: linguist-generated: true\nc.rb: gitlab-generated: set\nd.rb: linguist-generated: unset"
  const set = parseGeneratedAttrs(out)
  assert.ok(set.has("a.rb") && set.has("b.rb") && set.has("c.rb"))
  assert.equal(set.has("d.rb"), false)
})

test("parseMakefileTargets collects rule targets and skips variables and dot-directives", () => {
  const mk = [".PHONY: test lint", "CFLAGS := -O2", "PREFIX ?= /usr", "lint:", "\teslint .", "test:", "\tnode --test"].join("\n")
  const targets = parseMakefileTargets(mk)
  assert.ok(targets.has("lint") && targets.has("test"))
  assert.equal(targets.has(".PHONY"), false)
  assert.equal(targets.has("CFLAGS"), false)
})

test("detectVerifyCommands takes one command per group from package.json, ordered cheap-first", () => {
  const fs = fakeFs({
    "/repo/package.json": JSON.stringify({ scripts: { build: "tsc -b", lint: "eslint .", test: "node --test", "type-check": "tsc --noEmit" } }),
    "/repo/pnpm-lock.yaml": "",
  })
  const got = detectVerifyCommands("/repo", {}, fs)
  assert.equal(got.source, "package.json")
  assert.deepEqual(got.commands, ["pnpm run type-check", "pnpm run lint", "pnpm run test"])
})

test("detectVerifyCommands defaults to npm and ignores non-whitelisted or blank scripts", () => {
  const fs = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "node --test", deploy: "./ship.sh" } }) })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs).commands, ["npm run test"])
  const blank = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "   " } }) })
  assert.deepEqual(detectVerifyCommands("/repo", {}, blank), { commands: [], source: "none" })
})

test("detectVerifyCommands falls back to Makefile targets when there is no package.json", () => {
  const fs = fakeFs({ "/repo/Makefile": "lint:\n\teslint .\ntest:\n\tnode --test\ndeploy:\n\t./ship.sh\n" })
  const got = detectVerifyCommands("/repo", {}, fs)
  assert.equal(got.source, "Makefile")
  assert.deepEqual(got.commands, ["make lint", "make test"])
})

test("detectVerifyCommands lets an explicit REVIEW.yaml verify list win over autodetection", () => {
  const fs = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n  - pnpm -F api test\ninstructions:\n  - name: X\n    instructions: y\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs), { commands: ["pnpm -F api test"], source: "REVIEW.yaml" })
})

test("detectVerifyCommands skips autodetection under --all but still honors an explicit verify list", () => {
  const untrusted = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }) })
  assert.deepEqual(detectVerifyCommands("/repo", { all: true }, untrusted), { commands: [], source: "skipped-under-all" })
  const explicit = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n  - npm test\n",
    "/repo/package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", { all: true }, explicit), { commands: ["npm test"], source: "REVIEW.yaml" })
})

test("detectVerifyCommands returns nothing for a repo with no recognizable commands", () => {
  assert.deepEqual(detectVerifyCommands("/repo", {}, fakeFs({})), { commands: [], source: "none" })
  const malformed = fakeFs({ "/repo/package.json": "{ not json" })
  assert.deepEqual(detectVerifyCommands("/repo", {}, malformed), { commands: [], source: "none" })
})

test("detectVerifyCommands treats an empty verify: key as opting out, not as absent", () => {
  // `verify: []` means "do not verify". Falling through to autodetection here
  // would run the very commands the repo declined.
  const optedOut = fakeFs({
    "/repo/REVIEW.yaml": "verify: []\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, optedOut), { commands: [], source: "REVIEW.yaml" })

  // A REVIEW.yaml with no verify: key at all still autodetects.
  const noKey = fakeFs({
    "/repo/REVIEW.yaml": "disableDefaultLenses:\n  - performance\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, noKey), { commands: ["npm run test"], source: "package.json" })
})

test("detectVerifyCommands reads a verify: list written at zero indent", () => {
  const fs = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n- pnpm -F api test\n- make lint\ninstructions:\n  - name: X\n    instructions: y\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs), { commands: ["pnpm -F api test", "make lint"], source: "REVIEW.yaml" })
})

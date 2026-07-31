import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDiff, fnmatch, matchesInstruction, parseGeneratedAttrs, isBuiltinGenerated, markGenerated, parseMakefileTargets, detectVerifyCommands, parseTopLevelList } from "../skills/loupe/scripts/build-context.mjs"

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

test("isBuiltinGenerated matches a bare lockfile name at repo root and nested in a workspace", () => {
  assert.equal(isBuiltinGenerated("package-lock.json"), true)
  assert.equal(isBuiltinGenerated("packages/api/package-lock.json"), true)
  assert.equal(isBuiltinGenerated("go.sum"), true)
  assert.equal(isBuiltinGenerated("services/worker/go.sum"), true)
})

test("isBuiltinGenerated matches a suffix pattern by basename, not by substring", () => {
  assert.equal(isBuiltinGenerated("dist/app.min.js"), true)
  // Contains ".min.js" but does not end with it — real source, must not match.
  assert.equal(isBuiltinGenerated("src/min.jsx"), false)
  assert.equal(isBuiltinGenerated("notmin.js.ts"), false)
})

test("isBuiltinGenerated does not flag real source files with superficially similar names", () => {
  assert.equal(isBuiltinGenerated("src/package-lock-parser.js"), false)
  assert.equal(isBuiltinGenerated("lib/go.sum.test.js"), false)
})

test("markGenerated unions the built-in list with git-attribute exclusions in one run", () => {
  const attrGenerated = new Set(["custom-generated.rb"])
  const paths = ["custom-generated.rb", "package-lock.json", "src/real.js"]
  const generated = markGenerated(paths, attrGenerated)
  assert.ok(generated.has("custom-generated.rb")) // from attributes
  assert.ok(generated.has("package-lock.json"))   // from the built-in list
  assert.equal(generated.has("src/real.js"), false)
})

test("markGenerated preserves an attribute-only exclusion the built-in list doesn't mention", () => {
  const attrGenerated = new Set(["schema.generated.rb"])
  const generated = markGenerated(["schema.generated.rb", "src/real.js"], attrGenerated)
  assert.ok(generated.has("schema.generated.rb"))
  assert.equal(generated.has("src/real.js"), false)
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
  assert.deepEqual(detectVerifyCommands("/repo", {}, blank), { commands: [], source: null, skipped: "not-detected", repoSupplied: false })
})

test("detectVerifyCommands discloses each whitelisted script's own body plus its pre/post hooks", () => {
  // A whitelisted *name* says nothing about what it runs; `bodies` is what
  // lets the consent gate show the human the actual shell, `pre`/`post`
  // hooks included, since `npm run test` executes those too.
  const fs = fakeFs({
    "/repo/package.json": JSON.stringify({
      scripts: {
        test: "node --test",
        pretest: "node ./setup.js",
        posttest: "node ./teardown.js",
        lint: "eslint .",
      },
    }),
  })
  const got = detectVerifyCommands("/repo", {}, fs)
  assert.deepEqual(got.bodies, {
    pretest: "node ./setup.js",
    test: "node --test",
    posttest: "node ./teardown.js",
    lint: "eslint .",
  })
})

test("detectVerifyCommands omits a pre/post hook from bodies when the repo doesn't define one", () => {
  const fs = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }) })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs).bodies, { test: "node --test" })
})

test("detectVerifyCommands falls back to Makefile targets when there is no package.json", () => {
  const fs = fakeFs({ "/repo/Makefile": "lint:\n\teslint .\ntest:\n\tnode --test\ndeploy:\n\t./ship.sh\n" })
  const got = detectVerifyCommands("/repo", {}, fs)
  assert.equal(got.source, "Makefile")
  assert.equal(got.makefile, "Makefile")
  assert.deepEqual(got.commands, ["make lint", "make test"])
})

test("detectVerifyCommands resolves from GNUmakefile when a repo ships more than one makefile", () => {
  // GNU make itself resolves GNUmakefile, then makefile, then Makefile — reading
  // them in any other order can pick targets from a file `make` will never read,
  // which would show the consent gate (SKILL.md Step 6) the wrong recipe.
  const fs = fakeFs({
    "/repo/Makefile": "test:\n\techo BENIGN\n",
    "/repo/GNUmakefile": "test:\n\techo PAYLOAD\n",
  })
  const got = detectVerifyCommands("/repo", {}, fs)
  assert.equal(got.source, "Makefile")
  assert.equal(got.makefile, "GNUmakefile")
  assert.deepEqual(got.commands, ["make test"])
})

test("detectVerifyCommands lets an explicit REVIEW.yaml verify list win over autodetection", () => {
  const fs = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n  - pnpm -F api test\ninstructions:\n  - name: X\n    instructions: y\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs), { commands: ["pnpm -F api test"], source: "REVIEW.yaml", skipped: null, repoSupplied: true })
})

test("detectVerifyCommands resolves nothing the repo supplied under --all, including its own verify: list", () => {
  // --all targets repositories nobody has vetted. A `verify:` entry is handed to
  // a shell on the host, not to a reviewing model the way custom-lens
  // instructions are, so it gets no more trust here than an autodetected script.
  const untrusted = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }) })
  assert.deepEqual(detectVerifyCommands("/repo", { all: true }, untrusted), { commands: [], source: null, skipped: "all-mode", repoSupplied: false })
  const withReviewYaml = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n  - npm test\n",
    "/repo/package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", { all: true }, withReviewYaml), { commands: [], source: null, skipped: "all-mode", repoSupplied: false })
})

test("detectVerifyCommands marks every resolved command list as repo-supplied", () => {
  // The whitelist constrains the script *name*; the body that runs is the
  // repo's. `repoSupplied` is what the orchestrator's consent gate tests, so
  // every source that comes off disk must set it.
  const pkg = fakeFs({ "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }) })
  assert.equal(detectVerifyCommands("/repo", {}, pkg).repoSupplied, true)
  const mk = fakeFs({ "/repo/Makefile": "test:\n\tnode --test\n" })
  assert.equal(detectVerifyCommands("/repo", {}, mk).repoSupplied, true)
  const review = fakeFs({ "/repo/REVIEW.yaml": "verify:\n  - npm test\n" })
  assert.equal(detectVerifyCommands("/repo", {}, review).repoSupplied, true)
  // A deliberate `verify: []` opt-out is still repo *provenance*, so the flag
  // stays true even though the list is empty — the gate tests both, and only
  // asks when there is something to run.
  assert.equal(detectVerifyCommands("/repo", {}, fakeFs({ "/repo/REVIEW.yaml": "verify: []\n" })).repoSupplied, true)
  // A no-match resolved nothing off disk at all, so there is no provenance.
  assert.equal(detectVerifyCommands("/repo", {}, fakeFs({})).repoSupplied, false)
})

test("detectVerifyCommands returns nothing for a repo with no recognizable commands", () => {
  const nothing = { commands: [], source: null, skipped: "not-detected", repoSupplied: false }
  assert.deepEqual(detectVerifyCommands("/repo", {}, fakeFs({})), nothing)
  const malformed = fakeFs({ "/repo/package.json": "{ not json" })
  assert.deepEqual(detectVerifyCommands("/repo", {}, malformed), nothing)
})

test("detectVerifyCommands keeps provenance and skip-reason independent", () => {
  // `source` answers "where did this come from", `skipped` answers "why is there
  // nothing to run". An opt-out has both: a real provenance and a reason.
  const optedOut = detectVerifyCommands("/repo", {}, fakeFs({ "/repo/REVIEW.yaml": "verify: []\n" }))
  assert.equal(optedOut.source, "REVIEW.yaml")
  assert.equal(optedOut.skipped, "opted-out")
  const resolved = detectVerifyCommands("/repo", {}, fakeFs({ "/repo/Makefile": "test:\n\tnode --test\n" }))
  assert.equal(resolved.source, "Makefile")
  assert.equal(resolved.skipped, null) // something to run, so no reason to give
  const allMode = detectVerifyCommands("/repo", { all: true }, fakeFs({ "/repo/REVIEW.yaml": "verify:\n  - npm test\n" }))
  assert.equal(allMode.source, null) // nothing was resolved, so there is no provenance
  assert.equal(allMode.skipped, "all-mode")
})

test("detectVerifyCommands treats an empty verify: key as opting out, not as absent", () => {
  // `verify: []` means "do not verify". Falling through to autodetection here
  // would run the very commands the repo declined.
  const optedOut = fakeFs({
    "/repo/REVIEW.yaml": "verify: []\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, optedOut), { commands: [], source: "REVIEW.yaml", skipped: "opted-out", repoSupplied: true })

  // A REVIEW.yaml with no verify: key at all still autodetects.
  const noKey = fakeFs({
    "/repo/REVIEW.yaml": "disableDefaultLenses:\n  - performance\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, noKey), { commands: ["npm run test"], bodies: { test: "node --test" }, source: "package.json", skipped: null, repoSupplied: true })
})

test("detectVerifyCommands resolves the single-command shorthand `verify: npm test`, not an opt-out", () => {
  // Before, only the block sequence and inline `[a, b]` forms counted as a
  // list, while a separate key-presence check saw the key regardless — so a
  // bare scalar came back as `skipped: "opted-out"`, reporting that the repo
  // asked for no verification, the opposite of what it wrote. The two checks
  // are one function now; see `parseTopLevelList`'s comment for why.
  const fs = fakeFs({ "/repo/REVIEW.yaml": "verify: npm test\ninstructions:\n  - name: X\n    instructions: y\n" })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs), { commands: ["npm test"], source: "REVIEW.yaml", skipped: null, repoSupplied: true })
})

test("detectVerifyCommands reads a verify: list written at zero indent", () => {
  const fs = fakeFs({
    "/repo/REVIEW.yaml": "verify:\n- pnpm -F api test\n- make lint\ninstructions:\n  - name: X\n    instructions: y\n",
    "/repo/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  })
  assert.deepEqual(detectVerifyCommands("/repo", {}, fs), { commands: ["pnpm -F api test", "make lint"], source: "REVIEW.yaml", skipped: null, repoSupplied: true })
})

test("parseTopLevelList recognizes a block-scalar header even with a trailing inline comment", () => {
  // The `#` is only stripped by clean(); testing the raw capture let this
  // header slip past the block-scalar guard and resolve to a literal `|`
  // reported as a real (and non-empty) command.
  assert.deepEqual(parseTopLevelList("verify: | # our verification commands\n  npm test\n", "verify"), { items: [], present: true })
})

test("parseTopLevelList recognizes both chomping/indentation orders of a block-scalar header", () => {
  // YAML permits the indicator and the chomping/indentation suffix in either
  // order: `|-2` (chomping then indent) and `|2-` (indent then chomping) are
  // both valid, and the guard must reject both, not just one.
  assert.deepEqual(parseTopLevelList("verify: |2-\n  npm test\n", "verify"), { items: [], present: true })
  assert.deepEqual(parseTopLevelList("verify: |-2\n  npm test\n", "verify"), { items: [], present: true })
})

test("parseTopLevelList strips a trailing inline comment before testing the inline-list form", () => {
  // Before the fix, the three form-matchers ran against the raw line and
  // stripInlineComment only ran later, inside clean(), on an already-captured
  // value — so a comment on the header line defeated the inline-list matcher
  // and the line fell through to the scalar matcher as one bogus item: a
  // documented opt-out (`verify: []`) came back as an opt-in whose single
  // command was the literal string "[]".
  assert.deepEqual(
    parseTopLevelList("verify: [] # verification disabled on purpose", "verify"),
    { items: [], present: true },
  )
})

test("parseTopLevelList strips a trailing inline comment from a multi-item inline list", () => {
  assert.deepEqual(
    parseTopLevelList("verify: [npm test, npm run lint] # keep it cheap", "verify"),
    { items: ["npm test", "npm run lint"], present: true },
  )
})

test("parseTopLevelList strips a trailing inline comment from a bare block header", () => {
  // `verify: # comment` used to fall through to the scalar matcher and
  // resolve to the bogus item ["# comment"] instead of the empty block list
  // its author intended.
  assert.deepEqual(parseTopLevelList("verify: # comment\n", "verify"), { items: [], present: true })
})

test("parseTopLevelList strips a trailing inline comment so disableDefaultLenses isn't silently dropped", () => {
  // `disableDefaultLenses: [devops] # noisy` used to resolve to the bogus
  // item ["[devops]"] — matching no base-lens name, so the repo's disable
  // request was silently ignored while nothing disclosed that.
  assert.deepEqual(
    parseTopLevelList("disableDefaultLenses: [devops] # noisy", "disableDefaultLenses"),
    { items: ["devops"], present: true },
  )
})

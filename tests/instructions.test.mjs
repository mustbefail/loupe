import { test } from "node:test"
import assert from "node:assert/strict"
import { parseInstructionsYaml, loadCustomInstructions, loadDefaultLenses, parseDisabledLenses, loadDisabledLenses, parseVerifyCommands, parseTopLevelList } from "../skills/loupe/scripts/build-context.mjs"

const YAML = `---
# comment line
instructions:
  - name: General Standards
    fileFilters:
      - "**/*"
      - "!spec/**/*"
    instructions: |
      1. Use inclusive language.
      2. Verify CE/EE separation.
  - name: Ruby Quality
    fileFilters:
      - "**/*.rb"
    instructions: |
      Check for N+1 queries.
`

test("parseInstructionsYaml parses names, filters and block scalars", () => {
  const items = parseInstructionsYaml(YAML)
  assert.equal(items.length, 2)
  assert.equal(items[0].name, "General Standards")
  assert.deepEqual(items[0].fileFilters, ["**/*", "!spec/**/*"])
  assert.ok(items[0].instructions.includes("inclusive language"))
  assert.ok(items[0].instructions.includes("CE/EE separation"))
  assert.equal(items[1].name, "Ruby Quality")
  assert.deepEqual(items[1].fileFilters, ["**/*.rb"])
  assert.ok(items[1].instructions.trim().startsWith("Check for N+1"))
})

test("parseInstructionsYaml drops incomplete items", () => {
  const items = parseInstructionsYaml("instructions:\n  - name: Only Name\n")
  assert.equal(items.length, 0)
})

test("parseInstructionsYaml parses optional agent/reference and allows a lens with no fileFilters", () => {
  const y = `instructions:
  - name: DevOps
    agent: general-purpose
    reference: review-lenses.md#devops
    instructions: |
      Check infra config.
`
  const items = parseInstructionsYaml(y)
  assert.equal(items.length, 1)
  assert.equal(items[0].agent, "general-purpose")
  assert.equal(items[0].reference, "review-lenses.md#devops")
  assert.deepEqual(items[0].fileFilters, []) // no fileFilters is now allowed (= all files)
  assert.ok(items[0].instructions.includes("Check infra config."))
})

test("parseDisabledLenses reads block and inline forms and ignores unrelated YAML", () => {
  const block = `disableDefaultLenses:
  - devops
  - performance
instructions:
  - name: X
    instructions: |
      y
`
  assert.deepEqual(parseDisabledLenses(block), ["devops", "performance"])
  assert.deepEqual(parseDisabledLenses("disableDefaultLenses: [devops, security]\n"), ["devops", "security"])
  assert.deepEqual(parseDisabledLenses("instructions:\n  - name: X\n    instructions: y\n"), [])
})

test("parseVerifyCommands reads block and inline forms and keeps commands verbatim", () => {
  const block = `verify:
  - npm run typecheck
  - npx tsc --noEmit -p tsconfig.build.json
instructions:
  - name: X
    instructions: |
      y
`
  assert.deepEqual(parseVerifyCommands(block), ["npm run typecheck", "npx tsc --noEmit -p tsconfig.build.json"])
  assert.deepEqual(parseVerifyCommands('verify: ["npm test", make lint]\n'), ["npm test", "make lint"])
  assert.deepEqual(parseVerifyCommands("disableDefaultLenses:\n  - performance\n"), [])
})

test("parseTopLevelList accepts block items at zero indent and stops at the next key", () => {
  const yaml = `verify:
- npm test
- make lint
disableDefaultLenses:
- performance
`
  assert.deepEqual(parseVerifyCommands(yaml), ["npm test", "make lint"])
  assert.deepEqual(parseDisabledLenses(yaml), ["performance"])
})

test("parseTopLevelList treats a document separator as the end of the list, not an item", () => {
  // `---` satisfies the zero-indent item regex (dash, then `--`), so without an
  // explicit guard an empty `verify:` followed by a separator yields the command
  // `--`, which Step 7 would then try to run.
  assert.deepEqual(parseVerifyCommands("verify:\n---\ninstructions:\n  - name: X\n    instructions: y\n"), [])
  assert.deepEqual(parseDisabledLenses("disableDefaultLenses:\n---\n"), [])
  assert.deepEqual(parseVerifyCommands("verify:\n- npm test\n---\n- not an item\n"), ["npm test"])
})

test("parseVerifyCommands and parseDisabledLenses do not bleed into each other", () => {
  const yaml = `disableDefaultLenses:
  - performance
verify:
  - npm test
`
  assert.deepEqual(parseDisabledLenses(yaml), ["performance"])
  assert.deepEqual(parseVerifyCommands(yaml), ["npm test"])
})

test("parseVerifyCommands and parseDisabledLenses resolve a bare scalar to a one-item list", () => {
  // `verify: npm test` is unambiguous shorthand for a single command. Before,
  // only the block sequence and inline `[a, b]` forms were recognized as a
  // list at all, so this scalar resolved to zero items and was reported as
  // the repo opting out of verification entirely — the opposite of intent.
  assert.deepEqual(parseVerifyCommands("verify: npm test\ninstructions:\n  - name: X\n    instructions: y\n"), ["npm test"])
  assert.deepEqual(parseDisabledLenses("disableDefaultLenses: performance\n"), ["performance"])
  // Quotes and a trailing inline comment are stripped, same as the block-item
  // and inline-list forms.
  assert.deepEqual(parseVerifyCommands('verify: "npm test" # run unit tests\n'), ["npm test"])
})

test("parseTopLevelList reports key presence independently of how many items it resolved", () => {
  // `present` is what lets a caller tell a deliberate `verify: []` (opt-out)
  // from the key being absent (autodetect) — list length alone can't.
  assert.deepEqual(parseTopLevelList("verify: []\n", "verify"), { items: [], present: true })
  assert.deepEqual(parseTopLevelList("disableDefaultLenses:\n  - performance\n", "verify"), { items: [], present: false })
})

test("parseTopLevelList treats a bare block-scalar indicator as present but yields no items", () => {
  // `verify: |` / `verify: >` are YAML block-scalar sigils this targeted parser
  // does not follow onto their indented lines (unlike `parseInstructionsYaml`'s
  // `instructions: |`); taking the sigil itself as a one-item command would
  // silently hand a shell the literal `|`.
  assert.deepEqual(parseTopLevelList("verify: |\n  npm test\n", "verify"), { items: [], present: true })
  assert.deepEqual(parseTopLevelList("verify: >\n  npm test\n", "verify"), { items: [], present: true })
})

test("parseTopLevelList rejects a block-scalar indicator in every item form, not just the bare scalar", () => {
  // The guard was first written into the bare-scalar branch alone, so an
  // indicator arriving as an inline-list element or a sequence item still became
  // a command — a shell handed the literal `|`. It now sits where items are
  // added, so no form can reach around it.
  assert.deepEqual(parseTopLevelList("verify: [|, npm test]\n", "verify"), { items: ["npm test"], present: true })
  assert.deepEqual(parseTopLevelList("verify: [>, npm test]\n", "verify"), { items: ["npm test"], present: true })
  assert.deepEqual(parseTopLevelList("verify:\n  - |\n    npm test\n", "verify"), { items: [], present: true })
  assert.deepEqual(parseTopLevelList("verify:\n  - >-\n  - npm test\n", "verify"), { items: ["npm test"], present: true })
  // The bare-scalar form the guard originally covered still works.
  assert.deepEqual(parseTopLevelList("verify: |2-\n  npm test\n", "verify"), { items: [], present: true })
})

test("parseTopLevelList splits an inline list only on commas outside quotes", () => {
  // A verify command carries its own commas often enough to matter, and splitting
  // on every one of them tore a single command into fragments that `clean()` then
  // unquoted into separately runnable strings — half a command, plus a stray tail
  // the gate would show and a shell would try to execute.
  assert.deepEqual(
    parseTopLevelList('verify: ["nyc --reporter=text,lcov npm test", npm run lint]\n', "verify"),
    { items: ["nyc --reporter=text,lcov npm test", "npm run lint"], present: true },
  )
  assert.deepEqual(
    parseTopLevelList(`verify: ['npm test -- --grep "parse,dedup"', make lint]\n`, "verify"),
    { items: ['npm test -- --grep "parse,dedup"', "make lint"], present: true },
  )
  // Unquoted commas still separate — a plain scalar cannot contain one in YAML's
  // flow context, so this is the form the old behaviour got right.
  assert.deepEqual(parseTopLevelList("verify: [npm test, npm run lint]\n", "verify"), {
    items: ["npm test", "npm run lint"],
    present: true,
  })
  // An unterminated quote yields one item that won't run, not several that will.
  assert.deepEqual(parseTopLevelList('verify: ["npm test, npm run lint]\n', "verify"), {
    items: ['"npm test, npm run lint'],
    present: true,
  })
})

test("loadDisabledLenses reads the disable list from REVIEW.yaml", () => {
  const yaml = "disableDefaultLenses:\n  - performance\ninstructions:\n  - name: X\n    instructions: y\n"
  assert.deepEqual(loadDisabledLenses("/repo", { existsSync: () => true, readFileSync: () => yaml }), ["performance"])
  assert.deepEqual(loadDisabledLenses("/repo", { existsSync: () => false, readFileSync: () => { throw new Error("no") } }), [])
})

test("loadDefaultLenses loads the bundled base lenses with data-driven routing", () => {
  const defs = loadDefaultLenses()
  const names = defs.map((d) => d.name)
  for (const n of ["correctness", "security", "performance", "devops", "maintainability"]) assert.ok(names.includes(n), `missing ${n}`)
  assert.ok(defs.every((d) => d.type === "base"))
  assert.equal(defs.find((d) => d.name === "security").agent, "security-reviewer")
  assert.equal(defs.find((d) => d.name === "correctness").agent, "code-reviewer")
  const devops = defs.find((d) => d.name === "devops")
  assert.ok(devops.include_patterns.length > 0) // glob-scoped, not all-files
  const maintainability = defs.find((d) => d.name === "maintainability")
  assert.equal(maintainability.agent, "code-reviewer")
  assert.equal(maintainability.include_patterns.length, 0) // all-files
})

const COMMENT_YAML = `instructions:
  - name: General Standards # top-level
    fileFilters:
      - "**/*.rb" # ruby only
    instructions: Quick check. # note
`

test("parseInstructionsYaml strips inline # comments from name, fileFilters entry, and inline instructions", () => {
  const items = parseInstructionsYaml(COMMENT_YAML)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "General Standards")
  assert.deepEqual(items[0].fileFilters, ["**/*.rb"])
  assert.equal(items[0].instructions, "Quick check.")
})

const UNEVEN_INDENT_YAML = `instructions:
  - name: Uneven Block
    fileFilters:
      - "**/*"
    instructions: |
        - deeper first bullet
      - shallower second bullet
`

test("parseInstructionsYaml keeps both lines of an unevenly indented block scalar in a single item", () => {
  const items = parseInstructionsYaml(UNEVEN_INDENT_YAML)
  assert.equal(items.length, 1)
  assert.ok(items[0].instructions.includes("deeper first bullet"))
  assert.ok(items[0].instructions.includes("shallower second bullet"))
})

test("loadCustomInstructions returns [] when the instructions file does not exist", () => {
  const deps = { existsSync: () => false, readFileSync: () => { throw new Error("should not be called") } }
  const result = loadCustomInstructions("/repo", deps)
  assert.deepEqual(result, [])
})

test("loadCustomInstructions splits include/exclude patterns and strips the ! prefix", () => {
  const yaml = `instructions:
  - name: Ruby Quality
    fileFilters:
      - "**/*.rb"
      - "!spec/**/*"
    instructions: |
      Check for N+1 queries.
`
  const deps = { existsSync: () => true, readFileSync: () => yaml }
  const result = loadCustomInstructions("/repo", deps)
  assert.equal(result.length, 1)
  assert.equal(result[0].name, "Ruby Quality")
  assert.ok(result[0].instructions.includes("Check for N+1 queries."))
  assert.deepEqual(result[0].include_patterns, ["**/*.rb"])
  assert.deepEqual(result[0].exclude_patterns, ["spec/**/*"])
  assert.equal(result[0].type, "custom")
  assert.equal(result[0].agent, "code-reviewer") // default agent when none given
})

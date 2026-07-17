import { test } from "node:test"
import assert from "node:assert/strict"
import { parseInstructionsYaml, loadCustomInstructions, loadDefaultLenses } from "../skills/loupe/scripts/build-context.mjs"

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

test("loadDefaultLenses loads the bundled base lenses with data-driven routing", () => {
  const defs = loadDefaultLenses()
  const names = defs.map((d) => d.name)
  for (const n of ["correctness", "security", "performance", "devops"]) assert.ok(names.includes(n), `missing ${n}`)
  assert.ok(defs.every((d) => d.type === "base"))
  assert.equal(defs.find((d) => d.name === "security").agent, "security-reviewer")
  assert.equal(defs.find((d) => d.name === "correctness").agent, "code-reviewer")
  const devops = defs.find((d) => d.name === "devops")
  assert.ok(devops.include_patterns.length > 0) // glob-scoped, not all-files
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

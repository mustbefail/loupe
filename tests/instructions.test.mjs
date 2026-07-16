import { test } from "node:test"
import assert from "node:assert/strict"
import { parseInstructionsYaml } from "../scripts/build-context.mjs"

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

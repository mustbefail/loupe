import { test } from "node:test"
import assert from "node:assert/strict"
import { escapeHtml, formatDiffLines, formatCustomInstructions } from "../skills/loupe/scripts/build-context.mjs"

test("escapeHtml escapes markup", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;")
})

test("formatDiffLines tags added/deleted/context with line numbers", () => {
  const raw = ["@@ -1,2 +1,2 @@", "-old", "+new", " ctx"].join("\n")
  const out = formatDiffLines(raw)
  assert.ok(out.includes('<chunk_header>@@ -1,2 +1,2 @@</chunk_header>'))
  assert.ok(out.includes('<line type="deleted" old_line="1" new_line="">old</line>'))
  assert.ok(out.includes('<line type="added" old_line="" new_line="1">new</line>'))
  assert.ok(out.includes('<line type="context" old_line="2" new_line="2">ctx</line>'))
})

test("formatCustomInstructions wraps items with patterns", () => {
  const out = formatCustomInstructions([
    { name: "Ruby", include_patterns: ["**/*.rb"], exclude_patterns: ["spec/**/*"], instructions: "Check N+1." },
  ])
  assert.ok(out.includes("<custom_instructions>"))
  assert.ok(out.includes('For files matching "**/*.rb" (excluding: spec/**/*) - Ruby:'))
  assert.ok(out.includes("Check N+1."))
})

test("formatCustomInstructions is empty for no instructions", () => {
  assert.equal(formatCustomInstructions([]), "")
})

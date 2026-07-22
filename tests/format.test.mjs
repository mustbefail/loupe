import { test } from "node:test"
import assert from "node:assert/strict"
import { formatDiffLines } from "../skills/loupe/scripts/build-context.mjs"

test("formatDiffLines tags added/deleted/context with line numbers", () => {
  const raw = ["@@ -1,2 +1,2 @@", "-old", "+new", " ctx"].join("\n")
  const out = formatDiffLines(raw)
  assert.ok(out.includes('<chunk_header>@@ -1,2 +1,2 @@</chunk_header>'))
  assert.ok(out.includes('<line type="deleted" old_line="1" new_line="">old</line>'))
  assert.ok(out.includes('<line type="added" old_line="" new_line="1">new</line>'))
  assert.ok(out.includes('<line type="context" old_line="2" new_line="2">ctx</line>'))
})

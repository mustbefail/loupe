#!/usr/bin/env node
// build-context.mjs — deterministic review-context builder for the `loupe` skill.
// Ports the context-building half of duo-review-local.mjs (diff parsing, generated-file
// exclusion, custom-instruction matching, LLM-facing formatting) WITHOUT the Anthropic
// API / prompt-rendering / prescan halves — those are handled by Claude subagents.

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export function parseDiff(raw) {
  const files = []
  for (const section of raw.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue
    const oldPath = section.match(/^--- (?:a\/(.+)|\/dev\/null)$/m)?.[1]
      ?? section.match(/^rename from (.+)$/m)?.[1] ?? null
    const newPath = section.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/m)?.[1]
      ?? section.match(/^rename to (.+)$/m)?.[1] ?? null
    const binary = /^Binary files |^GIT binary patch/m.test(section)
    const hunkStart = section.search(/^@@ /m)
    files.push({
      oldPath, newPath,
      path: newPath ?? oldPath,
      newFile: /^new file mode /m.test(section),
      renamed: /^rename from /m.test(section),
      binary,
      diff: binary || hunkStart < 0 ? "" : section.slice(hunkStart),
    })
  }
  return files
}

export function parseGeneratedAttrs(out) {
  const set = new Set()
  for (const line of (out ?? "").split("\n")) {
    const m = line.match(/^(.*): (?:gitlab-generated|linguist-generated): (set|true)$/)
    if (m) set.add(m[1])
  }
  return set
}

export function fnmatch(name, pat) {
  let re = ""
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === "*" && pat[i + 1] === "*") {
      // Handle ** specially - matches zero or more path levels
      if (pat[i + 2] === "/") {
        // **/ matches zero or more directory levels followed by /
        re += "(?:.*/)?"
        i += 2  // Skip the second * and /
      } else {
        // ** at end or followed by non-slash
        re += ".*"
        i += 1  // Skip the second *
      }
    } else if (c === "*") re += ".*"
    else if (c === "?") re += "."
    else if (c === "[") {
      let j = i + 1
      if (pat[j] === "!") j++
      if (pat[j] === "]") j++
      while (j < pat.length && pat[j] !== "]") j++
      if (j >= pat.length) { re += "\\[" } else {
        let stuff = pat.slice(i + 1, j)
        if (stuff[0] === "!") stuff = "^" + stuff.slice(1)
        re += `[${stuff}]`
        i = j
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  try { return new RegExp(`^(?:${re})$`).test(name) } catch { return false }
}

export function matchesInstruction(path, ins) {
  const inc = !ins.include_patterns.length || ins.include_patterns.some((p) => fnmatch(path, p))
  const exc = ins.exclude_patterns.some((p) => fnmatch(path, p))
  return inc && !exc
}

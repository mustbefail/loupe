import { test } from "node:test"
import assert from "node:assert/strict"
import { parseConfig, normalizeList, loadCustomInstructions, loadDefaultLenses, loadDisabledLenses } from "../skills/loupe/scripts/build-context.mjs"

test("parseConfig reports parse-error for malformed JSON and for an empty file", () => {
  assert.deepEqual(parseConfig("{ not json").notices, [{ path: "", reason: "parse-error" }])
  assert.deepEqual(parseConfig("").notices, [{ path: "", reason: "parse-error" }])
})

test("parseConfig reports shape-invalid for a top-level array, and for instructions present but not an array", () => {
  assert.deepEqual(parseConfig("[]").notices, [{ path: "", reason: "shape-invalid" }])
  assert.deepEqual(
    parseConfig(JSON.stringify({ instructions: "not an array" })).notices,
    [{ path: "instructions", reason: "shape-invalid" }],
  )
})

test("parseConfig emits no notice when instructions is simply absent", () => {
  const r = parseConfig(JSON.stringify({ verify: ["npm test"] }))
  assert.deepEqual(r.config.instructions, [])
  assert.deepEqual(r.notices, [])
})

test("a config with only verify, or only disableDefaultLenses, is legal on its own", () => {
  // The three loaders read their keys independently — none of them requires
  // `instructions` to be present.
  assert.deepEqual(parseConfig(JSON.stringify({ verify: ["npm test"] })).notices, [])
  assert.deepEqual(parseConfig(JSON.stringify({ disableDefaultLenses: ["performance"] })).notices, [])
})

test("parseConfig drops an instructions element missing name or instructions, and checks the type before calling .trim()", () => {
  const onlyName = parseConfig(JSON.stringify({ instructions: [{ name: "Only Name" }] }))
  assert.deepEqual(onlyName.config.instructions, [])
  assert.deepEqual(onlyName.notices, [{ path: "instructions[0]", reason: "item-dropped" }])

  // A number here would throw calling .trim() on it if the type weren't
  // checked first — it must be dropped, not crash the loader.
  const wrongType = parseConfig(JSON.stringify({ instructions: [{ name: "X", instructions: 5 }] }))
  assert.deepEqual(wrongType.config.instructions, [])
  assert.deepEqual(wrongType.notices, [{ path: "instructions[0]", reason: "item-dropped" }])
})

test("parseConfig drops a non-string fileFilters element and keeps the rest", () => {
  const r = parseConfig(JSON.stringify({
    instructions: [{ name: "Ruby Quality", instructions: "Check for N+1 queries.", fileFilters: [1, "**/*.rb", "!spec/**/*"] }],
  }))
  assert.deepEqual(r.config.instructions[0].fileFilters, ["**/*.rb", "!spec/**/*"])
  assert.deepEqual(r.notices, [{ path: "instructions[0].fileFilters[0]", reason: "item-dropped" }])
})

test("parseConfig parses optional agent/reference and allows a lens with no fileFilters", () => {
  const r = parseConfig(JSON.stringify({
    instructions: [{ name: "DevOps", agent: "general-purpose", reference: "review-lenses.md#devops", instructions: "Check infra config." }],
  }))
  assert.equal(r.config.instructions.length, 1)
  assert.equal(r.config.instructions[0].agent, "general-purpose")
  assert.equal(r.config.instructions[0].reference, "review-lenses.md#devops")
  assert.deepEqual(r.config.instructions[0].fileFilters, []) // no fileFilters is allowed (= all files)
  assert.deepEqual(r.notices, [])
})

test("parseConfig resolves verify per the documented table", () => {
  const resolve = (verify) => parseConfig(JSON.stringify(verify === undefined ? {} : { verify }))

  assert.deepEqual(resolve(undefined).config.verify, { items: [], present: false })
  assert.deepEqual(resolve(undefined).notices, [])

  assert.deepEqual(resolve([]).config.verify, { items: [], present: true })
  assert.deepEqual(resolve([]).notices, [])

  assert.deepEqual(resolve(null).config.verify, { items: [], present: true })
  assert.deepEqual(resolve(null).notices, [])

  assert.deepEqual(resolve("npm test").config.verify, { items: ["npm test"], present: true })
  assert.deepEqual(resolve("npm test").notices, [])

  assert.deepEqual(resolve(["a", "b"]).config.verify, { items: ["a", "b"], present: true })
  assert.deepEqual(resolve(["a", "b"]).notices, [])

  const dropped = resolve([1, "a"])
  assert.deepEqual(dropped.config.verify, { items: ["a"], present: true })
  assert.deepEqual(dropped.notices, [{ path: "verify[0]", reason: "item-dropped" }])

  // `5` must not resolve to an opt-out: that would report the repo as having
  // declined verification when it actually made a type error.
  const typeInvalid = resolve(5)
  assert.deepEqual(typeInvalid.config.verify, { items: [], present: true })
  assert.deepEqual(typeInvalid.notices, [{ path: "verify", reason: "verify-type-invalid" }])

  assert.deepEqual(resolve(["  "]).config.verify, { items: [], present: true })
  assert.deepEqual(resolve(["  "]).notices, [])
})

test("parseConfig normalizes disableDefaultLenses from a bare string or an array, independent of verify", () => {
  assert.deepEqual(parseConfig(JSON.stringify({ disableDefaultLenses: "performance" })).config.disableDefaultLenses, ["performance"])
  const r = parseConfig(JSON.stringify({ disableDefaultLenses: ["performance"], verify: ["npm test"] }))
  assert.deepEqual(r.config.disableDefaultLenses, ["performance"])
  assert.deepEqual(r.config.verify, { items: ["npm test"], present: true })
  assert.deepEqual(r.notices, [])
})

test("normalizeList: null/absent, string, array-with-drops, and a wholly wrong type", () => {
  assert.deepEqual(normalizeList(null), { items: [], notices: [] })
  assert.deepEqual(normalizeList(undefined), { items: [], notices: [] })
  assert.deepEqual(normalizeList("a"), { items: ["a"], notices: [] })
  assert.deepEqual(normalizeList("  "), { items: [], notices: [] })
  assert.deepEqual(normalizeList(["a", 1, "b"]), { items: ["a", "b"], notices: [{ path: "[1]", reason: "item-dropped" }] })
  assert.deepEqual(normalizeList(5), { items: [], notices: [] })
})

test("loadDisabledLenses reads the disable list from REVIEW.json", () => {
  const json = JSON.stringify({ disableDefaultLenses: ["performance"], instructions: [{ name: "X", instructions: "y" }] })
  assert.deepEqual(
    loadDisabledLenses("/repo", { existsSync: (p) => p.endsWith("REVIEW.json"), readFileSync: () => json }),
    { names: ["performance"], notices: [] },
  )
  assert.deepEqual(
    loadDisabledLenses("/repo", { existsSync: () => false, readFileSync: () => { throw new Error("no") } }),
    { names: [], notices: [] },
  )
})

test("loadDefaultLenses loads the bundled base lenses with data-driven routing", () => {
  const { lenses: defs } = loadDefaultLenses()
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

test("loadDefaultLenses yields exactly 5 lenses from the bundled default.json", () => {
  assert.equal(loadDefaultLenses().lenses.length, 5)
})

test("loadDefaultLenses throws when the bundled config is missing or fails to parse", () => {
  assert.throws(() => loadDefaultLenses({ existsSync: () => false, readFileSync: () => { throw new Error("should not be called") } }))
  assert.throws(() => loadDefaultLenses({ existsSync: () => true, readFileSync: () => "{" }))
})

test("every base lens carries a reference and instructions that point at its own section", () => {
  // The prose lives in references/review-lenses.md, so a lens delivers its
  // checklist by naming the section rather than restating it. That makes both
  // halves load-bearing: an empty `instructions` or one naming the wrong
  // section leaves the reviewer with no checklist at all, and nothing else in
  // the loop would notice.
  for (const d of loadDefaultLenses().lenses) {
    assert.ok(d.instructions.trim().length > 0, `${d.name}: empty instructions`)
    assert.ok(d.reference, `${d.name}: missing reference`)
    assert.equal(d.reference, `review-lenses.md#${d.name}`)
    assert.ok(
      d.instructions.includes(`${d.name} section of references/review-lenses.md`),
      `${d.name}: instructions do not name its own section`,
    )
  }
})

test("the maintainability lens keeps its severity ceiling in the rules file", () => {
  // The ceiling is an output constraint the default `--severity-gate high`
  // leans on, and nothing in the code enforces it — Step 8 does not clamp. It
  // has to survive in the text the reviewer is actually handed, so pin it here
  // rather than trusting that a prose edit will remember it.
  const m = loadDefaultLenses().lenses.find((d) => d.name === "maintainability").instructions
  assert.match(m, /cap severity at medium/i)
  assert.match(m, /never report blocker or high/i)
  assert.doesNotMatch(m, /report (blocker|high) (when|if|for)/i)
})

test("loadCustomInstructions returns [] lenses and no notices when there is no REVIEW.json and no leftover REVIEW.yaml", () => {
  const deps = { existsSync: () => false, readFileSync: () => { throw new Error("should not be called") } }
  assert.deepEqual(loadCustomInstructions("/repo", deps), { lenses: [], notices: [] })
})

test("loadCustomInstructions reports yaml-unsupported when the repo has a leftover REVIEW.yaml and no REVIEW.json", () => {
  const deps = { existsSync: (p) => p.endsWith("REVIEW.yaml"), readFileSync: () => { throw new Error("should not be read") } }
  assert.deepEqual(loadCustomInstructions("/repo", deps), { lenses: [], notices: [{ path: "REVIEW.yaml", reason: "yaml-unsupported" }] })
})

test("loadCustomInstructions splits include/exclude patterns and strips the ! prefix", () => {
  const json = JSON.stringify({
    instructions: [{ name: "Ruby Quality", fileFilters: ["**/*.rb", "!spec/**/*"], instructions: "Check for N+1 queries." }],
  })
  const deps = { existsSync: (p) => p.endsWith("REVIEW.json"), readFileSync: () => json }
  const { lenses: result, notices } = loadCustomInstructions("/repo", deps)
  assert.equal(result.length, 1)
  assert.equal(result[0].name, "Ruby Quality")
  assert.ok(result[0].instructions.includes("Check for N+1 queries."))
  assert.deepEqual(result[0].include_patterns, ["**/*.rb"])
  assert.deepEqual(result[0].exclude_patterns, ["spec/**/*"])
  assert.equal(result[0].type, "custom")
  assert.equal(result[0].agent, "code-reviewer") // default agent when none given
  assert.deepEqual(notices, [])
})

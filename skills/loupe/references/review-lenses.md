# Review Lenses (Base)

`loupe`'s base lenses are defined in `rules/default.yaml` — the same YAML
schema as a repo's `REVIEW.yaml`, plus an `agent` key (which reviewer subagent
runs the lens) and a `reference` key (which section here holds its checklist).
`correctness`, `security`, and `performance` run on every reviewable file each
iteration; `devops` is a base lens too, but it is glob-scoped to
infrastructure/CI files and only runs when the diff touches them. Custom lenses
matched from the reviewed repo's own `REVIEW.yaml` run alongside these (see
`custom-instructions.md`); a custom lens whose `name` matches a base lens
overrides it.

Each lens object from `build-context.mjs` carries `type` (`"base"` or
`"custom"`), `agent` (`code-reviewer`, `security-reviewer`, or
`general-purpose`), and `files` (its matched slice). A lens with no include
patterns (`correctness`/`security`/`performance`) receives every reviewable
changed file; a scoped lens (`devops` and most custom lenses) receives only
its matched files.

Each checklist below is a distillation of general, widely-agreed code-review
practice for that concern — not a transcription of any specific tool's
prompts. Apply the checklist for your assigned lens only, to the file slice
(diff + original) you were given, and return findings per
`output-format.md`.

**Stay in your lane.** Reviewer subagents run in isolated contexts and
cannot see each other's output within an iteration, so there is no runtime
guard against three lenses all flagging the same line. Avoid that by
scope discipline: `correctness` does not file security findings, `security`
does not file pure performance findings, and so on — even when an issue
technically touches more than one concern, file it once, under whichever
lens is the primary concern, and let the other lenses stay silent on it.

## `correctness`

Checklist:

- **Logic errors** — off-by-one errors, inverted conditionals, wrong
  operator (`&&` vs `||`, `<` vs `<=`), incorrect boundary handling at the
  edges of a range or collection.
- **Null/missing-value handling** — does every path that dereferences an
  optional, nullable, or "may not exist" value check for it first? Any new
  path that can crash on `null`/`nil`/`undefined`/`None`?
- **Error handling** — are errors from I/O, network, or parsing caught and
  handled meaningfully (not silently swallowed, not caught with an
  overly-broad catch-all that hides unrelated failures)?
- **Concurrency correctness** — shared mutable state written without
  synchronization, time-of-check/time-of-use gaps, async code that assumes
  an ordering the runtime doesn't guarantee.
- **API/contract adherence** — does the change honor the documented
  behavior and type signature of the functions/interfaces it calls or
  modifies? Does it break a public interface's existing callers without
  updating them?
- **Test coverage for new logic** — does new or changed logic have a test
  that would fail if the logic were reverted? Are the realistic edge cases
  (empty input, boundary values, error paths) exercised, not just the happy
  path?
- **Resource lifecycle** — are file handles, connections, locks, and timers
  released on every exit path, including error paths?
- **Data integrity** — can this change corrupt state, lose data, or leave
  the system in an inconsistent state if it fails partway through?

Severity guidance:

- **blocker** — provably wrong for the change's stated purpose, will crash
  on the happy path, or corrupts data.
- **high** — wrong behavior on a realistic input or edge case; a fallible
  operation (I/O, parsing, external call) with no error handling.
- **medium** — correct today but fragile: tight coupling to an
  implementation detail, an unhandled unlikely edge case, new logic with no
  test.
- **low** — style-adjacent correctness nits, redundant checks, a comment
  that no longer matches the code it describes.

## `security`

Checklist:

- **Injection** — is user-controlled input concatenated into SQL, a shell
  command, HTML/JS, an LDAP query, or a template string without
  parameterization or escaping?
- **Authentication/authorization** — does a new or changed endpoint/action
  verify not just that the caller is authenticated, but that they are
  authorized for *that specific resource* (no missing ownership/tenant
  check)?
- **Secrets handling** — any credentials, API keys, tokens, or connection
  strings hardcoded, logged, or written in cleartext anywhere reachable?
- **Sensitive data exposure** — does the change log, cache, or return PII,
  PHI, payment-card data, or financial account numbers in a response, log
  line, or error message where it doesn't need to be?
- **Input validation** — is externally-supplied data (request bodies, query
  params, uploaded files, environment variables) validated for type, size,
  and range before use?
- **Unsafe deserialization** — any use of unsafe deserialization
  (`eval`, `pickle`, unrestricted YAML loading, etc.) on data that could
  originate from outside the trust boundary?
- **Cryptography** — weak or broken primitives (MD5/SHA-1 for password
  storage, ECB mode, a predictable IV, a non-cryptographic RNG used for a
  token or session id)?
- **SSRF / path traversal** — does user input influence a URL, hostname, or
  file path that the server then fetches or opens, without an allowlist or
  path-containment check?
- **Dependency risk** — does the change add a new third-party dependency?
  Flag unmaintained or unusually obscure packages, and flag any dependency
  under a restrictive license (GPL, AGPL, or similar copyleft terms) before
  it's adopted — this is a policy concern independent of any CVE.
- **Least privilege** — does new code request or grant broader permissions,
  scopes, or grants (DB privileges, IAM policy, file permissions) than the
  feature actually needs?

Severity guidance:

- **blocker** — exploitable injection, an authentication/authorization
  bypass, a hardcoded secret, or exposure of PII/PHI/payment data.
- **high** — a missing authorization check on a sensitive action, unsafe
  deserialization of untrusted input, weak cryptography protecting
  security-relevant data.
- **medium** — defense-in-depth gaps on an already-authenticated path
  (e.g. missing input validation), verbose error messages that leak
  internals (stack traces, file paths, library versions).
- **low** — hardening suggestions with no demonstrated exploit path.

## `performance`

Checklist:

- **Algorithmic complexity** — does the change turn a linear operation into
  quadratic-or-worse (nested loops re-scanning the same collection, a
  linear lookup repeated inside a loop that could use a map/set)?
- **N+1 queries** — does new code issue a database or API call inside a
  loop where batching, a join, or eager loading would do one call instead
  of many?
- **Unbounded growth** — does a cache, in-memory list, or buffer grow
  without an eviction policy or size limit relative to load?
- **Blocking in hot paths** — does the change add synchronous I/O (disk,
  network, DB) to a request path, event loop, or async context where it
  blocks other concurrent work?
- **Redundant work** — is the same data being recomputed, re-parsed, or
  re-serialized more than once within a request or iteration when it could
  be computed once and reused?
- **Memory footprint** — are large objects held in memory longer than
  needed, or loaded wholesale where streaming or pagination would avoid it?
- **Concurrency use** — is there a missed opportunity to parallelize
  independent I/O-bound work, or, conversely, newly-added unbounded
  parallelism with no concurrency limit?

Severity guidance:

- **blocker** — makes a hot or critical path pathologically slow, or risks
  resource exhaustion (e.g. unbounded growth that can OOM the process)
  under expected load.
- **high** — an N+1 query, blocking I/O newly added to a hot path, or a
  complexity regression on a path that sees realistic, non-trivial input
  sizes.
- **medium** — a real but bounded inefficiency (e.g. missing pagination on
  an internal tool whose dataset is small today but will grow).
- **low** — a micro-optimization opportunity with no measured or plausible
  real-world impact. Do not report these as anything higher than `low` —
  premature optimization on an unproven hot path is noise, not a finding,
  and should generally be omitted rather than filed at all unless clearly
  worth a human's attention.

## `devops`

Scope: runs only on infrastructure, CI, container, and deploy files
(Dockerfiles, Compose, Terraform/HCL, GitHub Actions and GitLab CI, Ansible,
Kubernetes/Helm, CDK). Review the operational correctness and safety of that
configuration — leave application-logic bugs to `correctness` and app-level
authn/authz to `security`.

Checklist:

- **Image hygiene** — base images pinned to a digest or specific version
  (never a bare `:latest`); minimal, trusted base; multi-stage builds that
  don't copy secrets or build-only tooling into the final image; a
  `.dockerignore` that keeps `.git`, secrets, and `node_modules` out of the
  build context.
- **Least privilege in containers** — runs as a non-root user where it can;
  no gratuitous `--privileged`, added capabilities, or host mounts;
  read-only root filesystem where feasible.
- **Secrets** — no credentials, tokens, private keys, or connection strings
  committed into Dockerfiles, Compose, CI workflows, or IaC; secrets come
  from a secret store or masked CI variables, never `ENV`/plaintext in the
  repo.
- **IaC least privilege** — IAM policies, roles, security groups, and bucket
  policies grant only what's needed (no `Action: "*"` / `Resource: "*"`, no
  `0.0.0.0/0` ingress on sensitive ports); state/backends encrypted.
- **Idempotency & safety** — Ansible tasks declare proper state and are
  idempotent; Terraform changes that destroy or replace stateful resources
  are intentional and guarded; provider/module versions pinned.
- **Reliability** — healthchecks, resource requests/limits, and restart
  policies set where the platform expects them; no obvious new single point
  of failure.
- **CI/CD safety** — third-party actions pinned to a commit SHA (not a moving
  tag); no secret echoed to logs; workflows on untrusted triggers (e.g.
  `pull_request_target`) don't run attacker-controlled code with privileged
  tokens; least-privilege `permissions:` on the workflow/job.

Severity guidance:

- **blocker** — a committed secret/credential/private key; a public exposure
  of a sensitive resource (open security group to a database, world-readable
  bucket); a CI workflow that runs untrusted input with privileged secrets.
- **high** — a container running as root without need, an over-broad
  IAM/policy wildcard, an unpinned base image or CI action on a
  security-relevant path, a non-idempotent or destructive provisioning step
  without a guard.
- **medium** — missing healthcheck/resource limits, missing `.dockerignore`,
  a moving version tag on a non-critical dependency.
- **low** — style/consistency nits in config (ordering, naming, formatting)
  with no operational impact.

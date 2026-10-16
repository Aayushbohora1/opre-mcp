# Development log

A running record of what was built, what was verified, and what is still open. Newest milestone
first. "Verified" means exercised by an automated test, not merely compiled.

---

## Post-Milestone — usability, performance, project layout — **verified**

### Project layout (`refactor: modernise the project layout`)

- Directories are named by a readable slug (`example-com`, `example-com-2` on collision); the
  unique id stays in `opre.json`.
- Renames: `research/overview.md → research/report.md`,
  `planning/implementation-plan.md → planning/plan.md`,
  `validation/test-results.json → validation/runs.json`, `generated-app/ → app/`.
- New `src/project/index-document.ts` generates the project `README.md` (stage, progress, next task,
  layout map) inside the existing generated markers, refreshed on create/research/plan/build/
  validation. `deriveStage()` is now the single source of truth for the project stage, shared with
  `opre.get_project_status`.

### Tool surface (`feat: guide tool + single-source tool copy`)

- `src/tools/catalog.ts` is the one owner of every tool title and description, written to a fixed
  shape (purpose → when to reach for it → what it returns → what it will not do) and kept short,
  because a longer description is paid on every turn.
- New `opre.get_guide` (25th tool): returns the stage, counts, the exact next 1-4 tool calls with
  example arguments, the guardrails that matter now, the unknowns that must be stated, and a map of
  where each artefact lives. Sized under 3 kB and asserted as such.
- Server `instructions` rewritten as a short playbook that points at `opre.get_guide`.

### Performance (measured, `npm run bench`)

| Operation                        | Before | After       |
| -------------------------------- | ------ | ----------- |
| cold start → first tool list     | 604 ms | ~290-300 ms |
| research, 4 pages, concurrency 3 | 3.84 s | 2.65 s      |

- Playwright is imported lazily in `src/research/browser.ts`; most tool calls never need a browser.
- Page inspection runs concurrently (`OPRE_RESEARCH_CONCURRENCY`, default 3) while results are
  recorded in frontier order, so runs stay deterministic.
- Measurements use a local multi-route fixture site, not a third-party site.

### Bug found and fixed by measuring

Running OPRE **from source** (`npm run dev`, tsx) broke research: the bundler rewrites
`page.evaluate` callbacks with helpers such as `__name`, which do not exist in the page, so every
page after the first failed with `ReferenceError: __name is not defined`. The built server was
unaffected, which is why the integration tests missed it. `installTransformShim()` now injects the
helpers as a **string** init script, and `tests/e2e/stdio.test.ts` drives the source entry point
over stdio to keep it fixed.

---

## Milestone 6 — `/opreapp` (authorised package inspection) — **verified**

- `src/research/app/zip.ts` — dependency-free ZIP central-directory reader (stored + deflate),
  ZIP64/encrypted entries reported instead of mis-parsed.
- `src/research/app/static-strings.ts` — AXML string-pool and DEX string-pool readers. These
  extract _declared_ strings only; every finding states that limitation.
- `src/research/app/inspect.ts` — assembles the inspection result (archive shape, declared
  permissions/components, resource names, identifier/endpoint samples) and persists it as findings
  and sources with explicit "what this cannot tell you" notes.
- `opre.inspect_app_package` requires an `app` project plus recorded authorisation; a `confirmAuthorised`
  flag records the operator's confirmation.
- Tests: `tests/integration/app-inspection.test.ts` builds a synthetic package (ZIP + AXML + DEX)
  and asserts declared capabilities, persisted findings and the authorisation gate.

**Not implemented:** decompilation to source, runtime/hook analysis, iOS-specific tooling beyond
`Info.plist` strings, and any automatic mapping from package structure to a web architecture —
that mapping is the agent's reasoning job, with OPRE supplying evidence.

---

## Milestone 5 — execution and validation — **verified**

- `src/validation/runner.ts` — starts the configured dev server with `shell: false`, a denylisted
  executable check, a metacharacter check on every argument, a fixed `app` working
  directory, a symlink-escape check, a scrubbed child environment and a port-readiness wait.
  `OPRE_RUNNER_ENABLED=false` disables it entirely.
- `src/validation/browser-checks.ts` — declarative checks (`navigate`, `assert_text`,
  `assert_visible`, `click`, `fill`, `screenshot`) recording expected vs observed, duration and a
  screenshot; a `navigate` check only passes on HTTP < 400.
- `src/validation/run.ts` — orchestrates a run, appends gaps to `validation/known-gaps.md`, counts
  attempts per task and stops at the configured limit with an explicit stop reason.
- Tests: `tests/integration/runner.test.ts` (command safety, real spawn, real stop) and the
  end-to-end workflow test in `tests/integration/mcp-server.test.ts`, which builds a small Node
  app in `app/`, starts it through OPRE and asserts a passing check with `observed`
  containing the rendered title.

**Not implemented:** traces, network fixtures, visual regression baselines, and coverage reports.

---

## Milestone 4 — planning and incremental building — **verified**

- `src/planning/planner.ts` — `draft` derives features/tasks from researched routes (per-route
  acceptance criteria, a foundation task, an end-to-end validation task); `apply` stores an
  agent-authored plan and rejects unknown dependencies.
- `src/planning/store.ts` — task persistence, status transitions, progress counts and
  dependency-aware `selectNextTask`.
- `src/build/context.ts` — assembles task-scoped context (task, features, supporting findings,
  evidence, relevant pages, decision tail, previous attempts, `app` state, validation
  plan) and deterministically trims it to a character budget, reporting what was dropped.
- `src/tools/build-tools.ts` — `opre.prepare_build_context` and
  `opre.record_implementation_result` (files, commands, acceptance results, gaps, feature status
  updates, task status transition).

**Not implemented:** automatic task splitting, time estimates, and cross-project task templates.

---

## Milestone 3 — website research — **verified**

- `src/research/inspector.ts` — Playwright crawl with per-request host filtering, BFS bounded by
  page/depth limits, DOM extraction (headings, links, forms with field names and required flags,
  interactive elements, assets), technology signals, console errors, failed requests, screenshots
  per configured viewport, and prompt-injection scanning of page text.
- Findings are generated per page (page surface, forms, technologies, injection signals,
  credential-shaped strings, HTTP failures) plus a crawl-level summary, each with evidence and
  limitations.
- `src/research/search-adapter.ts` — explicit provider model; `none` returns
  `unsupported_capability` instead of inventing results. SearXNG is supported.
- `src/research/report.ts` — regenerates `research/report.md` and `research/architecture.md`
  inside marker-delimited blocks.
- Tests: the integration suite crawls a local fixture site (with `OPRE_ALLOW_PRIVATE_NETWORK=true`)
  and asserts pages, forms, screenshots, injection warnings and the generated report.

**Known gaps:** no authenticated sessions, no per-viewport multi-capture in one run (one viewport
per run), no robots.txt policy evaluation beyond "do not bypass controls", and no JS-heavy SPA
route discovery.

---

## Milestone 2 — context-safe knowledge — **verified**

- Persistent features, findings (with embedded evidence), tasks, documents and notes.
- `opre.search_knowledge`: ranked, scoped, paginated, status-filtered search with a `revision`
  fingerprint; responses are halved down to fit the budget rather than truncated mid-object.
- `opre.get_evidence`, `opre.get_document_excerpt` (line-bounded), `opre.get_feature` return
  identifiers, summaries and excerpts — never the corpus.
- `opre.get_project_status` stays under a few kilobytes even for a large project (asserted in tests).
- Every list response is passed through `fitToBudget`, which reports how many items it dropped.

**Not implemented:** semantic/vector search, cross-project search, and ranking learned from usage.

---

## Milestone 1 — working foundation — **verified**

- TypeScript (strict, `NodeNext`), Node ≥ 20.10, official MCP SDK 1.32, Zod 3, Playwright, Vitest,
  ESLint (type-checked) and Prettier.
- `src/server.ts` builds a transport-agnostic `McpServer`; `src/index.ts` attaches stdio and keeps
  stdout clean for the protocol.
- 24 tools + 2 prompts, typed errors (`invalid_input`, `not_found`, `conflict`, `security_blocked`,
  `unsupported_capability`, `research_failed`, `validation_failed`, `io_error`, `config_error`,
  `internal_error`) with actionable hints.
- Project creation, isolation, resolution by name/id/path, and the documented directory layout.
- `tests/e2e/stdio.test.ts` launches the **built** server as a child process and drives it with a
  real MCP client over stdio.

---

## Open items

1. **Transport** — HTTP/streamable transport is deliberately out of scope for v1; the server object
   is transport-agnostic, so adding one should not touch the tool layer.
2. **Responsive capture** — run research once per viewport instead of only one viewport per run.
3. **Search providers** — add adapters (Brave/Bing/Google CSE) behind the same `SearchAdapter`
   interface; keep `none` the default.
4. **Validation depth** — richer check kinds (network assertions, form submission, multi-step flows)
   and per-check retries.
5. **Session memory** — an explicit "resume" summary tool that the agent can request at the start
   of a session without re-reading documents.
6. **Docs** — a worked example project (research → plan → build → validation transcript) recorded
   under `docs/examples/`.

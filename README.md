# OPRE — Open Rebuild Engine

**Understand. Rebuild. Reimagine.**

OPRE is an open-source, MCP-powered software research and reconstruction engine. It lets a
compatible AI agent investigate an existing website or application, build an evidence-backed
knowledge base, and then rebuild a working alternative through an incremental, test-driven loop.

- **Understand** — authorised browser inspection and static analysis that record _what was
  observed_, with sources, timestamps, confidence and explicit limitations.
- **Rebuild** — a dependency-ordered backlog, task-scoped context, and a local runner that
  actually starts and exercises the generated app.
- **Reimagine** — research a _capability_, not a screenshot. OPRE records observed facts,
  source-derived facts and hypotheses separately so the agent never guesses silently.

OPRE does **not** ship its own AI model. The connected agent reasons and writes code; OPRE
provides research, persistent project state, retrieval, task coordination and validation.

```
agent (reasoning + codegen)  <──MCP tools──>  OPRE (research · knowledge · planning · validation)
                                        └──>  project directory on disk (survives restarts)
```

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Connect a client](#connect-a-client)
- [The two workflows](#the-two-workflows)
- [Tool reference](#tool-reference)
- [Project layout](#project-layout)
- [Configuration (environment variables)](#configuration-environment-variables)
- [Context safety](#context-safety)
- [Security model](#security-model)
- [Development](#development)
- [What works today](#what-works-today)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Requirements

| Requirement                     | Notes                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Node.js ≥ 20.10 (LTS)           | Developed and tested on Node 22/24.                                                            |
| A Chromium build for Playwright | `npx playwright install chromium`. See [browser troubleshooting](#browser-troubleshooting).    |
| An MCP client                   | Any client that speaks stdio MCP (Claude Desktop, Claude Code, Cursor, Windsurf, Continue, …). |

---

## Install

```bash
git clone <your-fork> opre-mcp
cd opre-mcp
npm install
npm run build
node dist/index.js --help
```

During development you can run the server straight from TypeScript:

```bash
npm run dev            # tsx src/index.ts
npm test               # unit + integration (real browser, local fixtures)
npm run verify         # typecheck + lint + tests
```

Projects live under `OPRE_HOME` (default `~/.opre`). Each project is a self-contained directory.

---

## Connect a client

```json
{
  "mcpServers": {
    "opre": {
      "command": "node",
      "args": ["/absolute/path/to/opre-mcp/dist/index.js"],
      "env": {
        "OPRE_HOME": "/absolute/path/to/opre-projects",
        "OPRE_MAX_RESPONSE_CHARS": "24000"
      }
    }
  }
}
```

After connecting, the client should list 24 `opre.*` tools and two prompts (`opreweb`, `opreapp`).
Slash commands are an agent-side convention, not an MCP feature, so OPRE ships ready-made
instructions in [`agents/`](./agents) and [`/.claude/commands`](./.claude/commands) as well as MCP
prompts — use whichever your client supports.

Quick smoke test from a terminal:

```bash
node dist/index.js --print-config
```

---

## The two workflows

### `/opreweb <url>` — rebuild a website

1. `opre.create_project` — validate and record the target URL plus your authorisation.
2. `opre.start_research` — inspect public pages with a real browser (routes, nav, forms,
   interactive elements, viewports, screenshots, console/network errors). Optional web search
   via a configured provider.
3. `opre.get_research_summary` — compact, bounded overview of what was learned.
4. `opre.create_implementation_plan` — `mode: "draft"` proposes features and tasks from the
   researched routes; refine with `opre.upsert_task` / `opre.upsert_feature`, or re-submit with
   `mode: "apply"`.
5. Configure the runner once: `opre.update_project_config` with `runnerCommand` / `runnerArgs` /
   `runnerPort` (e.g. `npm`, `["run", "dev", "--", "--port", "4173"]`).
6. Loop until the plan is satisfied:
   `opre.get_next_task` → `opre.prepare_build_context` → implement in `app/` →
   `opre.record_implementation_result` → `opre.run_validation`.
7. `opre.get_validation_report` and `validation/known-gaps.md` feed the next iteration.

### `/opreapp <package>` — rebuild an application as a web app

Same loop, different first steps:

1. `opre.create_project` with `targetType: "app"` and an explicit authorisation statement.
2. `opre.inspect_app_package` — authorised static analysis of a local `.apk`/`.ipa`/`.zip`
   (archive structure, declared permissions/components, resource names, DEX identifier and
   endpoint literals).
3. `opre.add_finding` for anything you learn from public documentation.
4. Plan, build and validate exactly as in `/opreweb`.

The output is always a **browser-based** application, not an Android package. OPRE recovers
_declared strings only_ — it never claims to have decompiled logic, and it records what it could
not observe.

---

## Tool reference

| Tool                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `opre.create_project`               | Create the persistent, isolated project directory.                      |
| `opre.list_projects`                | Discover project names/ids.                                             |
| `opre.get_project_status`           | Compact snapshot: stage, counts, progress, next action.                 |
| `opre.update_project_config`        | Dev-server command/args/port, app dir, allowed hosts, attempt limits.   |
| `opre.start_research`               | Browser inspection + optional search; writes evidence-backed findings.  |
| `opre.get_research_summary`         | Bounded research overview and explicit unknowns.                        |
| `opre.search_research`              | Ranked search over pages and findings.                                  |
| `opre.add_finding`                  | Record an observed/derived/hypothesis conclusion with limitations.      |
| `opre.search_knowledge`             | Bounded search across features, findings, evidence, pages, tasks, docs. |
| `opre.get_feature`                  | One feature with criteria, findings, evidence and tasks.                |
| `opre.upsert_feature`               | Create/update a feature record.                                         |
| `opre.get_evidence`                 | The observations behind findings.                                       |
| `opre.get_document_excerpt`         | Line-bounded excerpt of a project document.                             |
| `opre.record_note`                  | Append a requirement, decision, uncertainty or workflow note.           |
| `opre.create_implementation_plan`   | Draft or apply the feature/task plan.                                   |
| `opre.list_tasks`                   | Paginated backlog with blocked reasons.                                 |
| `opre.get_next_task`                | Highest-priority actionable task.                                       |
| `opre.upsert_task`                  | Create/update one task and its checks.                                  |
| `opre.update_task_status`           | Move a task through its lifecycle.                                      |
| `opre.prepare_build_context`        | Everything needed for one task, within a character budget.              |
| `opre.record_implementation_result` | Persist what was built, what passed, what is still missing.             |
| `opre.run_validation`               | Start/reuse the local server and run browser acceptance checks.         |
| `opre.get_validation_report`        | Validation history, failures per task, open gaps.                       |
| `opre.inspect_app_package`          | Authorised static inspection of an application package.                 |

Unsupported capabilities are never faked: tools return a structured
`unsupported_capability` error with an actionable hint (for example, no web-search provider
configured, or no Chromium available).

---

## Project layout

```
<OPRE_HOME>/<project>/
  opre.json                     manifest: target, authorisation, runner config, allowed hosts
  README.md                     generated index: stage, progress, next task, where things live
  research/
    report.md                   generated report (routes, findings index, errors, blocked requests)
    architecture.md             generated inferences + what cannot be known
    sources.json                every source with trust level and timestamp
    findings.json               findings with embedded evidence and limitations
    pages.json                  per-page inventory: links, forms, interactive elements, assets
  knowledge/
    features.json               features, acceptance criteria, status
    requirements.md             appended requirements
    decisions.md                appended decisions
    uncertainties.md            appended open questions / blocked tasks
    workflows/<id>.md           user-flow notes
  planning/
    plan.md                     generated plan (tasks in dependency order)
    tasks.json                  plan metadata + task records
  validation/
    runs.json                   structured validation runs
    known-gaps.md               failures appended by validation and build results
  artifacts/
    screenshots/                research and validation screenshots
    reports/                    build results, optional research HAR
  app/                          the rebuilt application (written by the agent)
```

The directory name is the readable project slug (`example-com`); a second project for the
same target becomes `example-com-2`. The unique id lives in `opre.json`.

Regenerated markdown (`README.md`, `research/report.md`, `research/architecture.md`,
`planning/plan.md`) is written between `<!-- opre:generated:begin -->` and
`<!-- opre:generated:end -->` markers. Anything you write outside those markers is preserved.

---

## Configuration (environment variables)

All configuration is environment-based, validated at startup, and printed by
`node dist/index.js --print-config`.

| Variable                       | Default                           | Purpose                                                     |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------- |
| `OPRE_HOME`                    | `~/.opre`                         | Directory that contains all projects. Must be absolute.     |
| `OPRE_MAX_RESPONSE_CHARS`      | `24000`                           | Hard ceiling for one tool response, in characters.          |
| `OPRE_MAX_ITEMS`               | `25`                              | Default page size for retrieval tools.                      |
| `OPRE_RESEARCH_MAX_PAGES`      | `25`                              | Page cap per research run.                                  |
| `OPRE_RESEARCH_MAX_DEPTH`      | `2`                               | Link depth per research run.                                |
| `OPRE_RESEARCH_TIMEOUT_MS`     | `30000`                           | Per-navigation timeout.                                     |
| `OPRE_RESEARCH_MAX_LINKS`      | `100`                             | Links captured per page.                                    |
| `OPRE_RESEARCH_VIEWPORTS`      | `desktop:1440x900;mobile:390x844` | Viewport list for responsive capture.                       |
| `OPRE_RESEARCH_SCREENSHOTS`    | `true`                            | Capture a screenshot per visited page.                      |
| `OPRE_RESEARCH_HAR`            | `false`                           | Record a HAR file into `artifacts/reports/`.                |
| `OPRE_USER_AGENT`              | OPRE bot UA                       | User agent used by the research/validation browser.         |
| `OPRE_WEB_SEARCH_PROVIDER`     | `none`                            | `none` or `searxng`. No provider ⇒ no search results, ever. |
| `OPRE_SEARXNG_URL`             | –                                 | Base URL of a SearXNG instance with JSON output enabled.    |
| `OPRE_SEARCH_MAX_RESULTS`      | `8`                               | Results kept per search query.                              |
| `OPRE_SEARCH_TIMEOUT_MS`       | `20000`                           | Search timeout.                                             |
| `OPRE_BROWSER_EXECUTABLE`      | –                                 | Path to an existing Chromium/Chrome binary.                 |
| `OPRE_BROWSER_HEADLESS`        | `true`                            | Run the browser headless.                                   |
| `OPRE_ALLOW_PRIVATE_NETWORK`   | `false`                           | Allow targets that resolve to private/loopback addresses.   |
| `OPRE_MAX_DOWNLOAD_BYTES`      | `25000000`                        | Size ceiling for package inspection inputs.                 |
| `OPRE_RUNNER_ENABLED`          | `true`                            | Master switch for starting the generated app.               |
| `OPRE_DEFAULT_PORT`            | `4173`                            | Port used when the project does not set one.                |
| `OPRE_SERVER_START_TIMEOUT_MS` | `60000`                           | How long to wait for the dev server.                        |
| `OPRE_VALIDATION_TIMEOUT_MS`   | `30000`                           | Per-check browser timeout.                                  |
| `OPRE_MAX_VALIDATION_ATTEMPTS` | `3`                               | Retries per task before the loop stops.                     |
| `OPRE_LOG_LEVEL`               | `error`                           | `silent`, `error`, `warn`, `info` (stderr only).            |

See [`.env.example`](./.env.example) for a copy-paste starting point.

### Browser troubleshooting

If `npx playwright install chromium` cannot download (restricted network), OPRE falls back in this
order: `OPRE_BROWSER_EXECUTABLE` → the full headless Chromium build → the default Playwright
Chromium. If none can launch, browser tools return an `unsupported_capability` error explaining
what to install — non-browser features keep working.

---

## Context safety

OPRE is designed around the assumption that the agent's context is expensive and finite.

- Retrieval tools return **ranked, bounded, paginated** results with ids — never the whole corpus.
- Document tools return **paths, sizes and excerpts**, not full file contents.
- Every response is measured against `OPRE_MAX_RESPONSE_CHARS`; when a payload is too large, items
  are dropped deterministically and the response says how many.
- `opre.prepare_build_context` assembles **only what one task needs** and reports which sections
  were trimmed, so the agent can request them explicitly.
- State (tasks, decisions, progress) lives on disk, so it never has to be re-fed every session.
- OPRE makes **no claim** about the host agent's context window, history or compaction. Its limits
  are character/byte ceilings it actually enforces, described as such.

---

## Security model

Research targets, pages, READMEs and packages are treated as **untrusted data**.

| Risk                                        | Mitigation                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in page content            | Content is stored as evidence with `trust: "untrusted"`, wrapped with an explicit warning, and scanned for injection patterns; matches become findings, not instructions. |
| Path traversal / writes outside the project | Every project-relative path goes through `resolveInside` and a symlink-escape check.                                                                                      |
| Unsafe URL schemes & SSRF                   | Only `http(s)`, no credentials in URLs, private/loopback literals blocked, DNS results checked, per-request filtering during crawling, redirects re-validated.            |
| Local file / secret exposure                | Credential-shaped strings are redacted before storage or output; child processes get a scrubbed environment.                                                              |
| Arbitrary command execution                 | No shell, ever. Denylisted executables, no metacharacters, fixed working directory inside the project, and `OPRE_RUNNER_ENABLED` kill switch.                             |
| Untrusted build scripts                     | OPRE never runs `npm install` or project scripts itself; you configure the dev command explicitly.                                                                        |
| Cross-project contamination                 | Every operation is scoped to one project directory; ids are resolved only under `OPRE_HOME`.                                                                              |
| Data loss                                   | Generated sections are marker-delimited; append-only notes; atomic writes (temp + rename).                                                                                |

OPRE will not bypass authentication, paywalls, access controls or anti-bot protections, and it has
no stealth, credential-theft or security-bypass features. Only analyse software you own or are
authorised to inspect. See [SECURITY.md](./SECURITY.md) for reporting issues.

---

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm run lint          # eslint (type-checked rules)
npm run format        # prettier
npm test              # unit + integration (80 tests, includes real-browser runs)
npm run test:e2e      # builds dist/ and drives the real stdio server with an MCP client
npm run verify        # everything the CI runs, minus the build
```

Manual smoke check against a real site (drives the built server through a real MCP client):

```bash
npm run build
node scripts/smoke.mjs https://example.com
```

Layout of the source:

```
src/
  config.ts            environment parsing/validation
  server.ts            MCP server assembly (transport-agnostic)
  index.ts             stdio entry point + CLI flags
  core/                errors, ids, atomic JSON store, markdown sections, budget helpers
  security/            path containment, URL/SSRF policy, untrusted-content handling
  project/             manifest, layout, create/resolve/list
  research/            crawler, search adapter, reports, app inspection (zip/axml/dex)
  knowledge/           features, documents, bounded search
  planning/            plan drafting/applying, task persistence, next-task selection
  build/               task-scoped build context, implementation results
  validation/          dev-server runner, browser checks, runs and feedback loop
  tools/               MCP tool registrations grouped by domain
```

Milestone status and design decisions are tracked in [`docs/DEVELOPMENT_LOG.md`](./docs/DEVELOPMENT_LOG.md).

---

## What works today

Verified by the test suite (unit + integration + stdio end-to-end):

- An MCP client can connect over stdio and call all 24 tools; two prompts are exposed.
- Projects are created, isolated, listed and resumed across server restarts.
- Website research runs a real Chromium against an authorised target and persists pages,
  screenshots, sources, findings and evidence; blocked requests and injection signals are recorded.
- Planning drafts a dependency-ordered plan from research; the next task is selected by priority
  and dependency readiness.
- Build context is task-scoped and budget-bounded; implementation results update task status,
  feature status and known gaps.
- The runner starts a real dev server (no shell, scrubbed env) and Playwright checks run against
  it; failures, screenshots, console errors and failed requests are stored and re-readable.
- Application packages are inspected statically with clear statements of what that cannot reveal.
- Security controls (path traversal, SSRF, shell metacharacters, denied executables, symlink
  escapes, secret redaction) are covered by tests.

## Known limitations

Stated plainly, and also returned by the tools themselves:

- **No AI model.** OPRE orchestrates; the connected agent does the reasoning and coding.
- **No web search by default.** Configure a SearXNG instance; otherwise OPRE says so instead of
  inventing results.
- **Authenticated areas are not visited.** OPRE does not bypass logins, paywalls or bot protection.
- **Crawl coverage is bounded** by page/depth/time limits; deeper areas stay unobserved.
- **Application inspection reads declared strings only** — no decompilation to source, no runtime
  behaviour, no server-side logic.
- **Visual equivalence is not proof of functional equivalence.** Validation checks are declarative
  assertions you define; OPRE does not claim completeness from a passing subset.
- **Transport** is stdio only in v1. The server is transport-agnostic, but no HTTP transport is
  shipped.
- **Not yet implemented:** multi-agent coordination, authenticated research sessions, diffing
  against a live target over time, and automatic dependency-manager support for generated apps.

---

## License

MIT — see [LICENSE](./LICENSE). Respect the licenses of third-party dependencies and of any project
you analyse; do not copy proprietary source into generated projects without authorisation.

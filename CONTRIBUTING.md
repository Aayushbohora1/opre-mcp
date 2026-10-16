# Contributing to OPRE

Thanks for helping make OPRE a dependable reconstruction engine. This document explains how to
set up, what we value in changes, and what the review bar is.

## Development setup

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm run lint          # eslint, type-checked rules
npm run format        # prettier
npm test              # unit + integration
npm run test:e2e      # builds dist/ and drives the real stdio server
npm run verify        # what CI runs
```

Node.js ≥ 20.10 is required. Browser-dependent tests need a Chromium build; run
`npx playwright install chromium` once.

## Ground rules

1. **Working code over plans.** A pull request should contain runnable, tested behaviour. If a
   feature is only partially implemented, say so in the PR description and in the development log.
2. **Never fake data.** No hardcoded example results, no fabricated citations, no mocked
   "research" in shipped code. Test fixtures live in `tests/`.
3. **Context safety is a feature, not an optimisation.** New retrieval tools must be paginated,
   bounded by `OPRE_MAX_RESPONSE_CHARS`, and return ids/paths rather than whole documents.
4. **Untrusted input stays untrusted.** Anything from a target — page text, package strings,
   search results, repository content — must be wrapped, scanned and stored as evidence. Never let
   it become an instruction.
5. **No shells, no silent network access.** Processes are spawned with an argument vector and a
   scrubbed environment; outbound requests go through the URL policy.
6. **Additive, honest errors.** Prefer a typed `OpreError` with a hint over a generic throw.

## Commit and PR style

- Conventional-ish prefixes: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- One logical change per commit; keep unrelated reformatting out of feature commits.
- Describe _what changed and why_, and paste the command you used to verify it.

## Adding a tool

1. Put domain logic in its module (`src/<domain>/…`), not in the tool registration file.
2. Register it with `server.registerTool`, giving a description that explains **when** to use it.
3. Wrap the handler with `toolHandler(config, …)` so errors, project resolution and response
   budgeting are consistent.
4. Add unit tests for the logic and an integration test that calls the tool through a real MCP
   client (`tests/integration/mcp-server.test.ts` shows the pattern).
5. Document it in the README tool table and the agent instructions under `agents/`.

## Milestones

Development is milestone-driven; see [`docs/DEVELOPMENT_LOG.md`](./docs/DEVELOPMENT_LOG.md) for the
current status. Pick an open item, and if you complete a milestone, run the full workflow test
(`tests/integration`) before claiming it done.

## Reporting bugs

Open an issue with the OPRE version, Node version, OS, the tool call, and the JSON error payload
(if any). See [SECURITY.md](./SECURITY.md) for security reports — please do not file those as
public issues.

## License

By contributing you agree that your work is licensed under the MIT license of this repository.

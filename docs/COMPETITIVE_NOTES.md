# Competitive notes: website-cloning MCPs and tools

Researched while building OPRE's asset/style capture. Sources: the projects' own READMEs and
vendor pages, October 2026. Take-aways are folded into the code, not just this file.

## Who is in this space

| Project                                                                       | Category                          | What it claims                                                                                                                                  | Weak spot (our opening)                                                           |
| ----------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Perfect-Web-Clone](https://github.com/ericshang98/perfect-web-clone)         | deterministic CLI + skill harness | "A screenshot is not a clone"; extract → plan → assemble → build → fingerprints → weight → score; "pixel-perfect is a gate table, not a prompt" | Needs a coding agent wired to their Python CLI; scoring is screenshot+hash based  |
| [Perfect-Web-Clone-IDE](https://github.com/ericshang98/Perfect-Web-Clone-IDE) | MCP server for cloning            | real DOM, computed styles, CSS variables, `@keyframes`, all assets, responsiveness                                                              | Python, single-config, no persistent knowledge base or provenance                 |
| [mirror-web-cli](https://github.com/SanjeevSaniel/mirror-web-cli)             | full-site mirror                  | images (incl. `srcset`, lazy, backgrounds), CSS with `url()` rewriting, JS, fonts, icons, video; offline-ready; framework detection             | Mirror, not reconstruction: no evidence, no verification, no rebuild loop         |
| [WebCloner](https://github.com/nikomarinovic/WebCloner)                       | full-site mirror                  | crawls internal pages, downloads HTML/CSS/images/fonts, rewrites links, dedups assets, writes a URL→local report                                | Mirror only; no scoring, no agent workflow                                        |
| [Firecrawl MCP](https://github.com/mendableai/firecrawl-mcp)                  | hosted/self-hosted scrape API     | markdown-first output, `map`/`crawl`/`extract`/`search`, screenshot option                                                                      | Markdown strips exactly what a _clone_ needs (DOM, assets, CSS); needs an API key |
| [@playwright/mcp](https://github.com/microsoft/playwright-mcp)                | browser automation                | accessibility-tree snapshots instead of screenshots: cheaper in tokens, resilient to layout reflow                                              | Not a reconstruction tool; no persistence or verification                         |
| Locofy / Builder.io / Anima                                                   | design-to-code                    | component detection, design tokens, Storybook reuse                                                                                             | Input is Figma designs, not a live URL                                            |
| ui.rip / v0 / Superdesign                                                     | screenshot-to-code                | paste a URL, get code                                                                                                                           | Guesses from pixels; the exact failure mode these projects' critics name          |

## What we adopt

1. **Localize real assets** (`src/research/assets.ts`). Every clone tool that works downloads the
   actual images, fonts, stylesheets and media, and rewrites URLs. We do the same: fetch through the
   browser's request context (cookies and headers included, no extra navigation), dedup by URL
   across routes, honour the same allowlist/SSRF policy as the crawler, and write a
   `URL → local file` manifest.
2. **Handle `srcset`, `poster`, lazy attributes and CSS `background-image`** — mirror-web-cli listed
   these as the difference between a working mirror and a broken one. Lazy-loaded images are
   collected after scrolling the page.
3. **Extract real CSS, not approximations** (`src/research/styles.ts`): same-origin stylesheet text
   (rules, `@media`, `@keyframes`), CSS custom properties, `@font-face` sources, plus a computed-style
   map keyed by an element signature.
4. **Score, don't assert** — we already diff structural fingerprints _and_ pixels; Perfect-Web-Clone
   arriving at the same conclusion independently ("a gate table, not a prompt") is corroboration.
   Our weights are published, and the diff names every difference.
5. **Accessibility tree as a cheap, reflow-resilient artifact**, per the Playwright-MCP argument, so
   the agent can reason about structure without screenshot tokens.
6. **Honest residual reporting** — the opencode `clone-website` playbook states plainly that "the
   original asset still cannot be recovered after bounded download attempts". We report the same:
   assets that 404, assets that are blocked, and the crawl limits, in `known-gaps.md`.

## What we deliberately do not adopt

- **A bundled multi-agent LLM system.** OPRE ships no model. Those projects run four Claude agents;
  we give the connected agent (Claude Code, opencode, Codex, …) deterministic tools and measured
  gates, and stay useful across all of them.
- **Screenshot-first cloning.** Every source above says it produces guessed, brittle code. We
  extract structure and styles; screenshots are a _reference_ for the agent and a _signal_ for the
  scorer, never the source of truth.
- **Silent mirroring.** Mirrors copy third-party code wholesale. OPRE records authorisation per
  project, and `opre.scaffold_app` refuses to run without it.
- **A hosted API dependency.** Everything runs locally against targets you name.

## Where OPRE ends up better than each of them

- vs. mirrors (mirror-web-cli, WebCloner): a mirror is not a rebuild. OPRE produces a _project_ —
  evidence, plan, tasks, acceptance criteria, validation and a fidelity score — so the agent owns
  maintainable code instead of a copied tree.
- vs. screenshot-to-code (ui.rip, v0): we diff the result against the real target and name the
  differences; they hand you code and a confidence.
- vs. the clone harnesses (Perfect-Web-Clone): they need a specific agent + Python CLI; OPRE is a
  plain MCP server any MCP client can drive, with the knowledge base and validation loop included.
- vs. Firecrawl: markdown output is the wrong shape for a clone; we keep the DOM, styles and assets.

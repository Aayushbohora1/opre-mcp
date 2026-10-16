---
description: Rebuild an application as a web app with OPRE (authorised package inspection)
argument-hint: <path-to-package>
---

Reconstruct the application at `$ARGUMENTS` as a **browser-based** application using the OPRE MCP
tools. Follow [`agents/README.md`](../../agents/README.md) exactly; the summary is:

1. `opre.create_project` — `target: "$ARGUMENTS"`, `targetType: "app"`, with an explicit
   `authorisation` statement. Only analyse software you own or may inspect.
2. `opre.inspect_app_package` — reads declared strings only (archive layout, permissions,
   components, resource names, DEX identifier/endpoint literals). Never describe it as recovered
   source code, and never call a discovered endpoint without authorisation.
3. `opre.add_finding` for public-documentation knowledge, always with `limitations`.
4. `opre.create_implementation_plan`, then the same build/validate loop as `/opreweb`:
   `opre.get_next_task` → `opre.prepare_build_context` → implement →
   `opre.record_implementation_result` → `opre.run_validation`.
5. Define features as user-visible capabilities, not Android components, and record every
   capability that cannot be reproduced on the web with `opre.record_note { kind: "uncertainty" }`.

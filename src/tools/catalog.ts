/**
 * The OPRE tool surface, in one place.
 *
 * Tool descriptions are what an agent reads before every call, so they live here
 * rather than being scattered through the registration files. Each entry is
 * written to a fixed shape:
 *
 *   one-line purpose -> when to reach for it -> what it returns -> what it will not do
 *
 * They stay deliberately short: a longer description costs context on every turn.
 */

export interface ToolCopy {
  title: string;
  description: string;
}

export const TOOL_COPY = {
  'opre.create_project': {
    title: 'Start a project',
    description:
      'Begin here. Creates an isolated, persistent workspace for a website or app target: manifest, research/, knowledge/, planning/, validation/, artifacts/, app/.\n' +
      'Returns the project name you pass to every later call.\n' +
      'Does not visit the target — research is a separate, explicit step.',
  },
  'opre.list_projects': {
    title: 'List projects',
    description:
      'All projects under OPRE_HOME with their names, ids and targets.\n' +
      'Use when a call needs a project name and you are not sure which one applies.',
  },
  'opre.get_project_status': {
    title: 'Project status',
    description:
      'One compact snapshot: stage (research → planning → building → complete), counts, task/feature progress, validation state, the next task and the recommended action.\n' +
      'Stays small even for large projects — it never returns the knowledge base.',
  },
  'opre.get_guide': {
    title: 'What to do next',
    description:
      'Returns a short, stage-aware playbook for this project: the exact next 1-3 tool calls with example arguments, the guardrails that matter right now, and the unknowns you must state.\n' +
      'Start here whenever you are unsure what to call, or when resuming work in a new session.',
  },
  'opre.update_project_config': {
    title: 'Project settings',
    description:
      'Sets the dev-server command/args/port, app directory, allowed research hosts, package-inspection authorisation and validation attempt limit.\n' +
      'Configure the runner once so opre.run_validation can start the app.\n' +
      'Commands run without a shell; destructive executables are rejected.',
  },
  'opre.start_research': {
    title: 'Research the target',
    description:
      'Opens the target in a real browser and records what it actually does: routes, navigation, forms (field names, labels, required flags), interactive elements, assets, technology signals, responsive screenshots, console errors and failed requests.\n' +
      'Every observation is stored as a finding with its source, confidence and limitations. Reports progress while it runs.\n' +
      'Respects the crawl limits and host allowlist; it never bypasses logins, paywalls or bot protection.',
  },
  'opre.get_research_summary': {
    title: 'Research summary',
    description:
      'Bounded overview of what research produced: route inventory, finding counts by kind and verification, technology signals, and an explicit list of what could not be observed.\n' +
      'Use instead of reading the raw page list.',
  },
  'opre.search_research': {
    title: 'Search research',
    description:
      'Ranked search over researched pages and findings (terms, technologies, routes).\n' +
      'Returns ids you can expand with opre.get_evidence.',
  },
  'opre.add_finding': {
    title: 'Record a finding',
    description:
      'Stores a conclusion you reached: what was observed vs. what you derived vs. what is still a hypothesis, with confidence, optional evidence and — required in good practice — what it does NOT establish.\n' +
      'Use for knowledge the crawler could not get, such as documentation or behaviour behind a login.',
  },
  'opre.search_knowledge': {
    title: 'Search the knowledge base',
    description:
      'Ranked, paginated search across features, findings, evidence, pages, tasks and documents.\n' +
      'Returns ids, snippets and a revision fingerprint — never the whole knowledge base.\n' +
      'Reach for this instead of re-reading files you already saw.',
  },
  'opre.get_feature': {
    title: 'Get a feature',
    description:
      'One feature in full: summary, status, verifiable acceptance criteria, the findings and evidence behind it, and the tasks that implement it.\n' +
      'Read this before implementing a feature so the criteria drive the work.',
  },
  'opre.upsert_feature': {
    title: 'Create or update a feature',
    description:
      'Writes a feature record. Omit featureId to create one; pass it to update.\n' +
      'Keep acceptance criteria concrete and checkable — validation runs execute them.',
  },
  'opre.get_evidence': {
    title: 'Get evidence',
    description:
      'The observations behind a finding: quotes, measurements, DOM facts, each with its source reference and collection time.\n' +
      'Use it to check a claim before you rely on it.',
  },
  'opre.get_document_excerpt': {
    title: 'Read a document',
    description:
      'A line-bounded excerpt of one project document (research report, requirements, decisions, uncertainties, plan, known gaps), or the document index.\n' +
      'Use pagination instead of reading a whole file into context.',
  },
  'opre.record_note': {
    title: 'Record a note',
    description:
      'Appends a dated note to requirements, decisions, uncertainties, or a workflow document.\n' +
      'Appends never overwrite your text; credential-shaped strings are redacted.',
  },
  'opre.create_implementation_plan': {
    title: 'Plan the build',
    description:
      'Turns research into a dependency-ordered backlog and writes planning/plan.md.\n' +
      'mode "draft" proposes features and tasks derived from the researched routes; mode "apply" stores the plan you author.\n' +
      'Plan before building, and refine until every task has verifiable acceptance criteria.',
  },
  'opre.list_tasks': {
    title: 'List tasks',
    description:
      'The backlog with status, dependencies and, for blocked tasks, exactly what blocks them.\n' +
      'Paginated, so it stays cheap on large projects.',
  },
  'opre.get_next_task': {
    title: 'Next task',
    description:
      'The highest-priority task whose dependencies are satisfied, with its acceptance criteria and validation plan.\n' +
      'This is the entry point of the build loop: take a task, implement only that task, record it, validate it, repeat.',
  },
  'opre.upsert_task': {
    title: 'Create or update a task',
    description:
      'Writes one task: description, dependencies, acceptance criteria and browser checks.\n' +
      'Use to refine a drafted plan or to add follow-up work discovered while building.',
  },
  'opre.update_task_status': {
    title: 'Update task status',
    description:
      'Moves a task through pending → in_progress → done / failed / blocked / cancelled and records notes, changed files and attempt counts.\n' +
      'Status drives dependency resolution and survives restarts.',
  },
  'opre.prepare_build_context': {
    title: 'Prepare build context',
    description:
      'Assembles everything one task needs: the task, its features and acceptance criteria, the findings and evidence justifying them, relevant routes, recent decisions, previous attempts, the current state of app/, and the validation plan.\n' +
      'Bounded to a character budget; anything trimmed is reported so you can fetch it explicitly.',
  },
  'opre.record_implementation_result': {
    title: 'Record the result',
    description:
      'Stores what you actually did: files changed, commands run and their exit codes, which acceptance criteria are met, and the gaps you found.\n' +
      'Updates task and feature status, and records gaps so the next session continues where you stopped.',
  },
  'opre.run_validation': {
    title: 'Run validation',
    description:
      "Starts the configured dev server (or reuses a running one), opens the app in Chromium, runs the task's acceptance checks, and records the outcome with screenshots, console errors and failed requests.\n" +
      'Failures are written to validation/known-gaps.md for the next iteration. Stops after the configured attempt limit instead of looping forever.',
  },
  'opre.get_validation_report': {
    title: 'Validation report',
    description:
      'Validation history: recent runs, failures per task, open gaps, and the detail of any single run.\n' +
      'Use it to decide what to fix next.',
  },
  'opre.capture_assets': {
    title: 'Download the real assets',
    description:
      'Downloads the images, fonts, stylesheets and media the target actually renders — including srcset sources, video posters and computed background images — into artifacts/assets/, deduped across routes, with the captured CSS rewritten to point at the local files.\n' +
      'This is the step that turns "evidence about a site" into material you can build against. Off-allowlist and private URLs are refused and reported.\n' +
      'Run it after opre.start_research, before opre.scaffold_app.',
  },
  'opre.get_reference_pack': {
    title: 'Get everything to copy',
    description:
      'One call that returns, per route, the local paths of: the reference screenshot, the accessibility tree, the captured stylesheet and computed-style map, the asset manifest — plus the heading outline, text-block count, forms, controls, landmarks and design tokens to match.\n' +
      'Call this before writing code so the agent works from the real target instead of guessing from pixels.',
  },
  'opre.scaffold_app': {
    title: 'Scaffold a runnable copy',
    description:
      "Writes a runnable starting point into app/: one HTML file per route using the observed landmarks, headings, text, forms, controls and image alts, the target's own stylesheet, and the localised assets — plus a tiny static server and a route map.\n" +
      'It is a baseline to refine, not a finished clone; the agent owns the remaining detail and opre.run_validation scores the result.\n' +
      'Refuses to run without a recorded authorisation, and never overwrites existing work without force=true.',
  },
  'opre.inspect_app_package': {
    title: 'Inspect an app package',
    description:
      'Authorised static analysis of a local .apk/.ipa/.zip: archive structure, declared permissions and components, resource names, and DEX identifier/endpoint literals.\n' +
      'Reads DECLARED STRINGS ONLY — no decompilation, no runtime behaviour — and every finding says so.\n' +
      'Requires an app project with recorded authorisation. Never call a discovered endpoint without permission.',
  },
} satisfies Record<string, ToolCopy>;

export type ToolName = keyof typeof TOOL_COPY;

export function copyFor(name: ToolName): ToolCopy {
  return TOOL_COPY[name];
}

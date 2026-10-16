/**
 * Canonical on-disk layout for an OPRE project.
 *
 * ```
 * <project>/
 *   opre.json                 manifest: target, authorisation, runner config
 *   README.md                 generated project index (status, next task, doc links)
 *   research/
 *     report.md               generated research report
 *     architecture.md         generated inferences + what cannot be known
 *     pages.json              route inventory
 *     findings.json           findings with embedded evidence
 *     sources.json            provenance for every finding
 *   knowledge/
 *     features.json           features, acceptance criteria, status
 *     requirements.md         appended requirements
 *     decisions.md            appended decisions
 *     uncertainties.md        appended open questions and blocked tasks
 *     workflows/<id>.md       user-flow notes
 *   planning/
 *     plan.md                 generated implementation plan
 *     tasks.json              plan metadata + task records
 *   validation/
 *     runs.json               structured validation runs
 *     known-gaps.md           failures appended by validation and build results
 *   artifacts/
 *     screenshots/            research and validation screenshots
 *     reports/                build results, optional research HAR
 *   app/                      the rebuilt application (written by the agent)
 * ```
 */

import { join } from 'node:path';
import { resolveInside } from '../security/paths.js';

export interface ProjectPaths {
  root: string;
  manifest: string;
  readme: string;
  research: string;
  report: string;
  sources: string;
  findings: string;
  pages: string;
  architecture: string;
  knowledge: string;
  features: string;
  requirements: string;
  decisions: string;
  uncertainties: string;
  workflows: string;
  planning: string;
  plan: string;
  tasks: string;
  artifacts: string;
  screenshots: string;
  reports: string;
  validation: string;
  runs: string;
  knownGaps: string;
  app: string;
}

export function projectPaths(root: string): ProjectPaths {
  const research = resolveInside(root, 'research');
  const knowledge = resolveInside(root, 'knowledge');
  const planning = resolveInside(root, 'planning');
  const artifacts = resolveInside(root, 'artifacts');
  const validation = resolveInside(root, 'validation');
  return {
    root,
    manifest: join(root, 'opre.json'),
    readme: join(root, 'README.md'),
    research,
    report: join(research, 'report.md'),
    sources: join(research, 'sources.json'),
    findings: join(research, 'findings.json'),
    pages: join(research, 'pages.json'),
    architecture: join(research, 'architecture.md'),
    knowledge,
    features: join(knowledge, 'features.json'),
    requirements: join(knowledge, 'requirements.md'),
    decisions: join(knowledge, 'decisions.md'),
    uncertainties: join(knowledge, 'uncertainties.md'),
    workflows: join(knowledge, 'workflows'),
    planning,
    plan: join(planning, 'plan.md'),
    tasks: join(planning, 'tasks.json'),
    artifacts,
    screenshots: join(artifacts, 'screenshots'),
    reports: join(artifacts, 'reports'),
    validation,
    runs: join(validation, 'runs.json'),
    knownGaps: join(validation, 'known-gaps.md'),
    app: resolveInside(root, 'app'),
  };
}

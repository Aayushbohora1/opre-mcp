/**
 * Canonical on-disk layout for an OPRE project.
 *
 * ```
 * <project>/
 *   opre.json
 *   research/{overview.md,sources.json,findings.json,pages.json,architecture.md}
 *   knowledge/{features.json,requirements.md,decisions.md,uncertainties.md,workflows/}
 *   planning/{implementation-plan.md,tasks.json}
 *   artifacts/{screenshots/,reports/}
 *   validation/{test-results.json,known-gaps.md}
 *   generated-app/
 * ```
 */

import { join } from 'node:path';
import { resolveInside } from '../security/paths.js';

export interface ProjectPaths {
  root: string;
  manifest: string;
  research: string;
  overview: string;
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
  implementationPlan: string;
  tasks: string;
  artifacts: string;
  screenshots: string;
  reports: string;
  validation: string;
  testResults: string;
  knownGaps: string;
  generatedApp: string;
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
    research,
    overview: join(research, 'overview.md'),
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
    implementationPlan: join(planning, 'implementation-plan.md'),
    tasks: join(planning, 'tasks.json'),
    artifacts,
    screenshots: join(artifacts, 'screenshots'),
    reports: join(artifacts, 'reports'),
    validation,
    testResults: join(validation, 'test-results.json'),
    knownGaps: join(validation, 'known-gaps.md'),
    generatedApp: resolveInside(root, 'generated-app'),
  };
}

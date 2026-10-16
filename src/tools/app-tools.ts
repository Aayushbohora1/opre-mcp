/** `/opreapp` support: authorised static inspection of an application package. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpreConfig } from '../config.js';
import { SecurityError } from '../core/errors.js';
import { writeResearchReports } from '../research/report.js';
import {
  assertInspectionAuthorised,
  inspectAppPackage,
  persistInspection,
} from '../research/app/inspect.js';
import { readFindings, readPages, readSources } from '../research/store.js';
import { argNumber, argString, toolHandler } from './context.js';

export function registerAppTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.inspect_app_package',
    {
      title: 'Inspect an application package',
      description:
        'Static, authorised inspection of a local .apk/.ipa/.zip: archive structure, declared Android permissions and components, resource names, and DEX identifier/endpoint literals. It recovers declared strings only — no logic, no server behaviour — and every result records that limitation. Requires a project with targetType "app" and recorded authorisation.',
      inputSchema: {
        project: z.string().describe('Project name or id (must have targetType "app").'),
        packagePath: z
          .string()
          .describe(
            'Path to the package file. Absolute, or project-relative when it is stored inside the project.',
          ),
        maxDexStrings: z
          .number()
          .int()
          .optional()
          .describe('Maximum DEX strings to read per dex file (default 20000).'),
        confirmAuthorised: z
          .boolean()
          .optional()
          .describe(
            'Set true to confirm you own or are authorised to analyse this package. Required the first time.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      if (project.manifest.targetType !== 'app') {
        throw new SecurityError('This project was created for a website target.', {
          hint: 'Create a project with targetType "app" to inspect application packages.',
        });
      }
      if (
        record['confirmAuthorised'] === true &&
        !project.manifest.config.packageInspectionAuthorised
      ) {
        project.manifest.config.packageInspectionAuthorised = true;
      }
      assertInspectionAuthorised(project.manifest.config.packageInspectionAuthorised);

      const packagePath = argString(record, 'packagePath');
      if (packagePath === undefined) {
        throw new SecurityError('packagePath is required.');
      }

      const result = await inspectAppPackage(project.paths.root, {
        packagePath,
        maxEntryBytes: config.network.maxDownloadBytes,
        maxDexStrings: argNumber(record, 'maxDexStrings') ?? 20_000,
      });
      await persistInspection(project.paths, result);

      const [pages, findings, sources] = await Promise.all([
        readPages(project.paths),
        readFindings(project.paths),
        readSources(project.paths),
      ]);
      await writeResearchReports(project.paths, {
        manifest: project.manifest,
        pages,
        findings,
        sources,
        notes: [`Package inspection: ${result.file}`],
        blockedRequests: [],
        errors: result.warnings,
        screenshotCount: 0,
        searchProvider: 'not-used',
      });

      return {
        data: {
          package: {
            file: result.file,
            format: result.format,
            entries: result.entries,
            topLevel: result.topLevel,
            permissions: result.permissions,
            components: result.components.slice(0, 30),
            resourceNames: result.resourceNames.slice(0, 30),
            dexStrings: {
              total: result.dexStrings.total,
              urls: result.dexStrings.urls.slice(0, 20),
              identifierSamples: result.dexStrings.samples.slice(0, 20),
            },
            warnings: result.warnings.slice(0, 10),
          },
          findingsAdded: result.findings.length,
          explicitlyUnknown: result.unknown,
          guardrails: [
            'Only declared strings were read; no code was decompiled, patched or executed.',
            'Discovered endpoints must not be called without explicit authorisation.',
            'The output is a web-based alternative: re-implement user-visible behaviour, not Android APIs.',
          ],
          nextStep:
            'Create features with opre.upsert_feature that describe the user-visible capabilities, then plan with opre.create_implementation_plan.',
        },
      };
    }),
  );
}

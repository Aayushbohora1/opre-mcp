/**
 * Clone-support tools: download the target's real assets, hand the agent a
 * reference pack, and scaffold a runnable starting point that uses it.
 *
 * These are the operations the mature cloning tools all perform (localise
 * assets, keep real CSS, score the result). They stay deterministic: no model is
 * involved, so the connected agent remains the only thing that writes features.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpreConfig } from '../config.js';
import { SecurityError, UnsupportedCapabilityError } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { appendSection } from '../core/json-store.js';
import { buildReferencePack, captureAssetsForProject } from '../research/reference-pack.js';
import { buildScaffold } from '../scaffold/builder.js';
import { readPages, writePages } from '../research/store.js';
import { copyFor } from './catalog.js';
import { argBoolean, argNumber, toolHandler } from './context.js';

const projectParam = z.string().describe('Project name or id.');

export function registerCloneTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.capture_assets',
    {
      title: copyFor('opre.capture_assets').title,
      description: copyFor('opre.capture_assets').description,
      inputSchema: {
        project: projectParam,
        maxAssetsPerRoute: z
          .number()
          .int()
          .optional()
          .describe('Maximum assets downloaded per route (default 60).'),
        maxBytes: z
          .number()
          .int()
          .optional()
          .describe('Total byte budget for the run (default OPRE_MAX_DOWNLOAD_BYTES).'),
        maxRoutes: z
          .number()
          .int()
          .optional()
          .describe('How many researched routes to process (default 12).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const pages = await readPages(project.paths);
      if (pages.length === 0) {
        throw new UnsupportedCapabilityError('This project has no researched pages yet.', {
          hint: 'Run opre.start_research first — asset capture follows the pages it found.',
        });
      }

      const limited =
        argNumber(record, 'maxRoutes') === undefined
          ? pages
          : pages.slice(0, argNumber(record, 'maxRoutes'));
      const result = await captureAssetsForProject(config, project.paths, limited, {
        allowedHosts: project.manifest.config.allowedHosts,
        ...(argNumber(record, 'maxAssetsPerRoute') === undefined
          ? {}
          : { maxAssetsPerRoute: argNumber(record, 'maxAssetsPerRoute')! }),
        ...(argNumber(record, 'maxBytes') === undefined
          ? {}
          : { maxBytes: argNumber(record, 'maxBytes')! }),
      });

      // Record the manifest on each page so the reference pack and the scaffold
      // can find the localised files.
      await writePages(
        project.paths,
        pages.map((page) => {
          const route = page.fingerprint?.route ?? page.url;
          const summary = result.routeManifests.find((entry) => entry.route === route);
          return summary === undefined
            ? page
            : {
                ...page,
                assetPack: {
                  manifestPath: summary.manifestPath,
                  cssPath: summary.cssPath,
                  total: summary.total,
                  ok: summary.ok,
                  failed: summary.failed,
                  skipped: summary.skipped,
                  bytes: summary.bytes,
                },
              };
        }),
      );

      if (result.blocked.length > 0) {
        await appendSection(
          project.paths.knownGaps,
          '## Assets not downloaded',
          result.blocked
            .slice(0, 20)
            .map((entry) => `- ${entry.url} — ${entry.reason}`)
            .join('\n'),
        );
      }

      return {
        data: {
          routes: result.routes,
          assetsFound: result.assets,
          downloaded: result.ok,
          failed: result.failed,
          skipped: result.skipped,
          reusedFromOtherRoutes: result.deduped,
          bytes: result.bytes,
          stylesheetsRewritten: result.stylesheetsRewritten,
          manifests: result.manifests,
          blocked: result.blocked.slice(0, 20),
          notes: result.notes,
          nextStep:
            'Call opre.get_reference_pack to see the screenshots, CSS, accessibility tree and assets for each route.',
        },
        listKey: 'manifests',
      };
    }),
  );

  server.registerTool(
    'opre.get_reference_pack',
    {
      title: copyFor('opre.get_reference_pack').title,
      description: copyFor('opre.get_reference_pack').description,
      inputSchema: {
        project: projectParam,
        maxRoutes: z.number().int().optional().describe('Routes to include (default 10).'),
        includeHeadings: z
          .boolean()
          .optional()
          .describe('Include the heading outline per route (default true).'),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const pages = await readPages(project.paths);
      const limit = argNumber(record, 'maxRoutes') ?? 10;
      const pack = await buildReferencePack(
        config,
        project.paths,
        project.manifest.name,
        project.manifest.target,
        pages.slice(0, limit),
      );
      if (record['includeHeadings'] === false) {
        pack.routes = pack.routes.map((route) => ({ ...route, headings: [] }));
      }
      return { data: { ...pack }, listKey: 'routes' };
    }),
  );

  server.registerTool(
    'opre.scaffold_app',
    {
      title: copyFor('opre.scaffold_app').title,
      description: copyFor('opre.scaffold_app').description,
      inputSchema: {
        project: projectParam,
        force: z
          .boolean()
          .optional()
          .describe('Overwrite an existing app/ directory (refused unless true).'),
        linkCss: z
          .boolean()
          .optional()
          .describe('Link the captured stylesheet in the generated HTML (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      if (project.manifest.authorisation.trim().toLowerCase() === 'unspecified') {
        throw new SecurityError(
          'Scaffolding a copy requires a recorded authorisation for this target.',
          {
            hint: 'Record how you are authorised to copy this site (e.g. "I own this site"). Scaffolding copies real HTML, CSS and assets, so OPRE will not do it on an unverified target.',
          },
        );
      }

      const pages = await readPages(project.paths);
      if (pages.length === 0) {
        throw new UnsupportedCapabilityError('No researched pages to scaffold from.', {
          hint: 'Run opre.start_research, then opre.capture_assets, then try again.',
        });
      }

      const appDir = join(project.paths.root, project.manifest.config.runner.appDir);
      const existing = await readdir(appDir).catch(() => []);
      if (existing.length > 0 && record['force'] !== true) {
        throw new SecurityError(`app/ already contains ${existing.length} entries.`, {
          hint: 'Pass force=true to overwrite, or build inside it by hand — OPRE never silently replaces work.',
        });
      }

      const outcome = await buildScaffold(
        project.paths,
        project.manifest.config.runner.appDir,
        pages,
        {
          // The schema takes a boolean; reading it as a string meant linkCss:false
          // was silently ignored and the rebuild still linked a stylesheet.
          linkCss: argBoolean(record, 'linkCss') ?? true,
        },
      );

      return {
        data: {
          appDir: project.manifest.config.runner.appDir,
          routes: outcome.routes,
          files: outcome.files,
          assetsLinked: outcome.assetsLinked,
          stylesheets: outcome.stylesheets,
          warnings: outcome.warnings,
          nextStep:
            'Run opre.update_project_config with the dev command, then opre.run_validation to score the scaffold against the reference.',
          generatedAt: nowIso(),
        },
        listKey: 'files',
      };
    }),
  );
}

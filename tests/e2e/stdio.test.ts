import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Proves that a standard MCP client can launch the built binary, connect over
 * stdio and call tools — the acceptance criterion for "an MCP-compatible client
 * can connect to OPRE".
 */
describe('stdio transport (built server)', () => {
  let home: string;
  let client: Client;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'opre-e2e-'));
    const serverPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      env: { ...process.env, OPRE_HOME: home, OPRE_MAX_RESPONSE_CHARS: '8000' },
      stderr: 'pipe',
    });
    client = new Client({ name: 'opre-e2e-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('reports server capabilities and instructions', () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    const instructions = client.getInstructions();
    expect(instructions).toContain('opre.create_project');
  });

  it('creates a project and returns it across processes', async () => {
    const created = (await client.callTool({
      name: 'opre.create_project',
      arguments: { target: 'https://example.com', targetType: 'web', authorisation: 'public site' },
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(created.content[0]!.text) as { project: string };
    expect(payload.project).toBe('example-com');

    const status = (await client.callTool({
      name: 'opre.get_project_status',
      arguments: { project: payload.project },
    })) as { content: Array<{ text: string }> };
    const statusPayload = JSON.parse(status.content[0]!.text) as {
      stage: string;
      project: { name: string };
    };
    expect(statusPayload.project.name).toBe(payload.project);
    expect(statusPayload.stage).toBe('research');
  });

  it('exposes a working /opreweb prompt', async () => {
    const prompt = await client.getPrompt({
      name: 'opreweb',
      arguments: { url: 'https://example.com' },
    });
    expect(JSON.stringify(prompt.messages)).toContain('opre.run_validation');
  });
});

describe('source mode (npm run dev, tsx)', () => {
  /**
   * Regression test: running OPRE from TypeScript source makes the bundler rewrite
   * `page.evaluate` callbacks, which used to fail with
   * "ReferenceError: __name is not defined" and silently drop every page after
   * the first. This drives the *source* entry point to keep that fixed.
   */
  it('researches a multi-page site without transform errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opre-e2e-src-'));
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.writeHead(200, { 'content-type': 'text/html' });
      if (path === '/') {
        response.end(
          '<!doctype html><title>Src home</title><h1>Home</h1><nav>' +
            [1, 2, 3].map((index) => `<a href="/section-${index}">Section ${index}</a>`).join('') +
            '</nav>',
        );
        return;
      }
      response.end(`<!doctype html><title>Src ${path}</title><h1>${path}</h1><a href="/">Home</a>`);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;

    const client = new Client({ name: 'opre-e2e-source', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      ],
      env: {
        ...process.env,
        OPRE_HOME: home,
        OPRE_ALLOW_PRIVATE_NETWORK: 'true',
        OPRE_RESEARCH_SCREENSHOTS: 'false',
      },
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const created = (await client.callTool({
        name: 'opre.create_project',
        arguments: {
          target: `http://127.0.0.1:${port}/`,
          targetType: 'web',
          authorisation: 'local fixture',
        },
      })) as { content: Array<{ text: string }> };
      const project = (JSON.parse(created.content[0]!.text) as { project: string }).project;

      const research = (await client.callTool({
        name: 'opre.start_research',
        arguments: { project, maxPages: 4, maxDepth: 1, includeScreenshots: false },
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(research.content[0]!.text) as {
        pagesVisited: number;
        errors: string[];
        routes: Array<{ url: string }>;
      };

      expect(payload.errors).toEqual([]);
      expect(payload.pagesVisited).toBeGreaterThan(1);
      expect(payload.routes.map((route) => route.url)).toEqual(
        expect.arrayContaining([`http://127.0.0.1:${port}/`, `http://127.0.0.1:${port}/section-1`]),
      );
    } finally {
      await client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});

import { mkdtemp, rm } from 'node:fs/promises';
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
    expect(payload.project).toMatch(/^example-com-[0-9a-f]{8}$/);

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

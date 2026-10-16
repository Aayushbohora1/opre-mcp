#!/usr/bin/env node
/**
 * OPRE entry point (stdio transport).
 *
 * stdout carries the MCP protocol only; diagnostics go to stderr, because a
 * stray log line on stdout corrupts the JSON-RPC stream.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type OpreConfig } from './config.js';
import { ConfigError } from './core/errors.js';
import { createOpreServer, SERVER_NAME, SERVER_VERSION } from './server.js';

interface CliOptions {
  help: boolean;
  version: boolean;
  printConfig: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    printConfig: argv.includes('--print-config'),
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      `${SERVER_NAME} ${SERVER_VERSION} — Open Rebuild Engine (MCP server)`,
      '',
      'Usage:',
      '  opre-mcp                 Start the MCP server on stdio (default).',
      '  opre-mcp --print-config  Print the effective configuration and exit.',
      '  opre-mcp --version       Print the version and exit.',
      '  opre-mcp --help          Show this help.',
      '',
      'Client configuration (example):',
      '  {',
      '    "mcpServers": {',
      '      "opre": {',
      '        "command": "node",',
      '        "args": ["/absolute/path/to/opre-mcp/dist/index.js"],',
      '        "env": { "OPRE_HOME": "/absolute/path/to/projects" }',
      '      }',
      '    }',
      '  }',
      '',
      'See README.md for all OPRE_* environment variables.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config: OpreConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`[${SERVER_NAME}] configuration error: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`);
    return;
  }

  const { server } = createOpreServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${SERVER_NAME}] ready on stdio (OPRE_HOME=${config.homeDir}, response budget ${config.maxResponseChars} chars)\n`,
  );

  const shutdown = (): void => {
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function redactConfig(config: OpreConfig): Record<string, unknown> {
  return {
    homeDir: config.homeDir,
    maxResponseChars: config.maxResponseChars,
    maxItems: config.maxItems,
    research: { ...config.research, viewports: config.research.viewports },
    search: { ...config.search, searxngUrl: config.search.searxngUrl },
    browser: { headless: config.browser.headless, executablePath: config.browser.executablePath },
    network: config.network,
    runner: config.runner,
    logLevel: config.logLevel,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[opre-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resolveServerSpec,
  assertSafeCommandLine,
  startDevServer,
  waitForPort,
} from '../../src/validation/runner.js';
import {
  SecurityError,
  UnsupportedCapabilityError,
  ValidationFailedError,
} from '../../src/core/errors.js';
import { createProject } from '../../src/project/store.js';
import { createTestEnv } from '../helpers.js';

describe('command safety', () => {
  it('rejects destructive executables', () => {
    for (const command of ['rm', 'del', 'powershell', 'bash', 'cmd.exe']) {
      expect(() => assertSafeCommandLine(command, [])).toThrow(SecurityError);
    }
  });

  it('rejects shell metacharacters in the command and arguments', () => {
    expect(() => assertSafeCommandLine('npm run dev && curl evil', [])).toThrow(SecurityError);
    expect(() => assertSafeCommandLine('npm', ['run', 'dev; rm -rf /'])).toThrow(SecurityError);
    expect(() => assertSafeCommandLine('npm', ['run', 'dev', '$(whoami)'])).toThrow(SecurityError);
  });

  it('accepts ordinary package-manager and interpreter commands', () => {
    expect(() =>
      assertSafeCommandLine('npm', ['run', 'dev', '--', '--port', '4173']),
    ).not.toThrow();
    expect(() => assertSafeCommandLine('node', ['server.js'])).not.toThrow();
  });
});

describe('resolveServerSpec', () => {
  it('requires a configured command', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });
      expect(() => resolveServerSpec(env.config, project.paths, project.manifest)).toThrow(
        UnsupportedCapabilityError,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('honours the disable switch and always uses the project app directory', async () => {
    const env = await createTestEnv({ OPRE_RUNNER_ENABLED: 'false' });
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
        runnerCommand: 'npm',
        runnerArgs: ['run', 'dev'],
      });
      expect(() => resolveServerSpec(env.config, project.paths, project.manifest)).toThrow(
        /disabled/i,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('rejects an appDir that escapes the project', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
        runnerCommand: 'npm',
        appDir: '../outside',
      });
      expect(() => resolveServerSpec(env.config, project.paths, project.manifest)).toThrow(
        SecurityError,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('passes a scrubbed environment to the child process', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
        runnerCommand: 'npm',
        runnerArgs: ['run', 'dev'],
      });
      const spec = resolveServerSpec(env.config, project.paths, project.manifest);
      expect(spec.cwd.endsWith('generated-app')).toBe(true);
      expect(spec.env['PORT']).toBeTypeOf('string');
      expect(Object.keys(spec.env)).not.toContain('OPENAI_API_KEY');
    } finally {
      await env.cleanup();
    }
  });
});

describe('startDevServer', () => {
  it('reports a clear failure when the command does not exist', async () => {
    const env = await createTestEnv();
    try {
      await expect(
        startDevServer(env.config, {
          command: 'opre-definitely-missing-binary',
          args: [],
          cwd: env.home,
          port: 45999,
          env: { PATH: process.env['PATH'] ?? '' },
        }),
      ).rejects.toThrow(ValidationFailedError);
    } finally {
      await env.cleanup();
    }
  });

  it('starts, serves and stops a real server without a shell', async () => {
    const env = await createTestEnv();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<h1>ok</h1>');
    });
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.listen(port, '127.0.0.1', resolve);
    });
    const livePort = (server.address() as AddressInfo).port;

    const child = createServer;
    try {
      expect(await waitForPort(livePort, 1_000)).toBe(true);
      const handle = await startDevServer(
        env.config,
        {
          command: process.execPath,
          args: [
            '-e',
            `require('node:http').createServer((_q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end('<h1>started</h1>')}).listen(${livePort + 1},'127.0.0.1')`,
          ],
          cwd: env.home,
          port: livePort + 1,
          env: { PATH: process.env['PATH'] ?? '' },
        },
        20_000,
      );
      expect(handle.baseUrl).toBe(`http://127.0.0.1:${livePort + 1}`);
      const response = await fetch(handle.baseUrl);
      expect(await response.text()).toContain('started');
      await handle.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await waitForPort(livePort + 1, 500)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      void child;
      await env.cleanup();
    }
  });
});

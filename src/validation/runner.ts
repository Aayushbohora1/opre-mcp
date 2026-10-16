/**
 * Local runner for the generated application.
 *
 * Safeguards (see README "Security model"):
 *  - no shell: commands are spawned with `shell: false` and an argument-vector;
 *  - the command must be a known-safe executable and every argument must be free
 *    of shell metacharacters;
 *  - the working directory is always the project's `generated-app` directory;
 *  - the child receives a scrubbed environment (no API keys, tokens or secrets);
 *  - disabling is possible with OPRE_RUNNER_ENABLED=false.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import type { OpreConfig } from '../config.js';
import {
  SecurityError,
  UnsupportedCapabilityError,
  ValidationFailedError,
} from '../core/errors.js';
import { safeChildEnv } from '../security/untrusted.js';
import type { ProjectPaths } from '../project/paths.js';
import type { ProjectManifest } from '../project/types.js';
import { assertNoSymlinkEscape, resolveInside } from '../security/paths.js';

const DENIED_EXECUTABLES = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'format',
  'reg',
  'regedit',
  'shutdown',
  'curl',
  'wget',
  'powershell',
  'pwsh',
  'cmd',
  'wscript',
  'cscript',
  'bash',
  'sh',
  'zsh',
  'chmod',
  'chown',
  'mkfs',
  'dd',
  'nc',
  'netcat',
  'ssh',
  'scp',
  'msiexec',
]);

const SHELL_METACHARACTERS = /[|;&<>`$(){}\n\r\\!*?[\]#~]/;

export interface ServerSpec {
  command: string;
  args: string[];
  cwd: string;
  port: number;
  env: Record<string, string>;
}

export interface DevServerHandle {
  baseUrl: string;
  port: number;
  command: string;
  log: string[];
  stop: () => Promise<void>;
}

export function resolveServerSpec(
  config: OpreConfig,
  paths: ProjectPaths,
  manifest: ProjectManifest,
  overrides: { command?: string; args?: string[]; port?: number } = {},
): ServerSpec {
  if (!config.runner.enabled) {
    throw new UnsupportedCapabilityError(
      'The local runner is disabled (OPRE_RUNNER_ENABLED=false).',
      {
        hint: 'Set OPRE_RUNNER_ENABLED=true, or validate a server you started yourself against http://127.0.0.1:<port>.',
      },
    );
  }

  const command = overrides.command ?? manifest.config.runner.command;
  if (command === null || command === undefined || command.trim() === '') {
    throw new UnsupportedCapabilityError(
      'No development-server command is configured for this project.',
      {
        hint: 'Call opre.update_project_config with runnerCommand (for example "npm") and runnerArgs (for example ["run","dev","--","--port","4173"]), or pass command/args to opre.run_validation.',
      },
    );
  }

  const args = overrides.args ?? manifest.config.runner.args;
  const port = overrides.port ?? manifest.config.runner.port ?? config.runner.defaultPort;

  assertSafeCommandLine(command, args);

  const cwd = resolveInside(paths.root, manifest.config.runner.appDir);
  return {
    command,
    args,
    cwd,
    port,
    env: { ...safeChildEnv(), PORT: String(port), NODE_ENV: 'development' },
  };
}

export function assertSafeCommandLine(command: string, args: string[]): void {
  const executable = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const stem = executable.replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (DENIED_EXECUTABLES.has(stem)) {
    throw new SecurityError(
      `Executable "${executable}" is not allowed to run inside an OPRE project.`,
      {
        hint: 'Configure a package-manager or interpreter command (npm, node, python, …) instead of a destructive utility.',
      },
    );
  }
  if (SHELL_METACHARACTERS.test(command)) {
    throw new SecurityError(
      'The server command contains shell metacharacters, which OPRE never executes.',
      {
        hint: 'Pass the executable and its arguments separately via runnerCommand / runnerArgs.',
      },
    );
  }
  for (const argument of args) {
    if (SHELL_METACHARACTERS.test(argument)) {
      throw new SecurityError(`Argument "${argument}" contains shell metacharacters.`, {
        hint: 'OPRE spawns processes without a shell; use plain arguments.',
      });
    }
  }
}

export async function startDevServer(
  config: OpreConfig,
  spec: ServerSpec,
  timeoutMs: number = config.runner.startTimeoutMs,
): Promise<DevServerHandle> {
  await assertNoSymlinkEscape(spec.cwd, spec.cwd);

  const log: string[] = [];
  let child: ChildProcess;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new ValidationFailedError(
      `Failed to start "${spec.command}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const record = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() !== '' && log.length < 200) {
        log.push(line.slice(0, 400));
      }
    }
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  let spawnError: string | null = null;
  child.on('error', (error) => {
    spawnError = error.message;
  });

  const readSpawnError = (): string | null => spawnError;
  const port = spec.port;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    const failure = readSpawnError();
    if (failure !== null) {
      await terminate(child);
      throw new ValidationFailedError(`"${spec.command}" could not be executed: ${failure}`, {
        hint: 'Check that the command exists on PATH and that node_modules are installed in the generated app.',
        details: { log: log.slice(0, 20) },
      });
    }
    if (child.exitCode !== null) {
      throw new ValidationFailedError(
        `"${spec.command}" exited with code ${child.exitCode} before the server became reachable.`,
        { details: { log: log.slice(0, 20) } },
      );
    }
    if (await waitForPort(port, 400)) {
      ready = true;
      break;
    }
    await delay(250);
  }

  const stop = async (): Promise<void> => {
    await terminate(child);
  };

  if (!ready) {
    await stop();
    throw new ValidationFailedError(
      `The server did not start listening on port ${port} within ${timeoutMs} ms.`,
      {
        hint: 'Increase OPRE_SERVER_START_TIMEOUT_MS, or start the app yourself and validate against http://127.0.0.1:<port>.',
        details: { log: log.slice(0, 20) },
      },
    );
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    command: `${spec.command} ${spec.args.join(' ')}`.trim(),
    log,
    stop,
  };
}

export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const finish = (result: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

export async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  const pid = child.pid;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      killer.on('exit', () => {
        resolve();
      });
      killer.on('error', () => {
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await delay(200);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

import { Client, type ClientChannel } from 'ssh2';
import os from 'node:os';
import type { Connection } from '../types.js';
import { getSecret } from '../secrets.js';

/**
 * Interactive terminal sessions ("Web Terminal").
 *
 * Unlike the one-shot runner (executors/runner.ts) which spawns a process, captures its
 * output to a log file and streams it read-only, a terminal session is a real bidirectional
 * PTY:
 *   - local  → node-pty  (optional native module; degrades gracefully if absent)
 *   - ssh    → ssh2's interactive shell channel (no extra deps)
 *
 * Output is NOT scrubbed of OSC/escape noise the way the runner scrubs it: an interactive
 * shell *wants* its colored prompt, title sequences, aliases and rc files. We also keep the
 * user's full environment instead of stripping prompt/integration vars.
 */

export interface TermSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface OpenTermOptions {
  connection: Connection;
  cols: number;
  rows: number;
  onData(data: string): void;
  onExit(exitCode: number | null): void;
  /** Non-fatal/connection error — surfaced to the user as a terminal line. */
  onError(message: string): void;
}

const noopSession: TermSession = {
  write() {},
  resize() {},
  kill() {},
};

// ---------------------------------------------------------------------------
// node-pty (optional)
//
// Loaded via a non-literal specifier so `tsc` never tries to resolve its types and the
// build stays green when the module isn't installed. Result is cached (null = unavailable).
// ---------------------------------------------------------------------------
let ptyLoad: Promise<any> | undefined;
function loadPty(): Promise<any> {
  if (!ptyLoad) {
    const spec = 'node-pty';
    ptyLoad = import(spec).catch(() => null);
  }
  return ptyLoad;
}

function pickShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const ps = process.env.OPSLAB_WIN_SHELL ?? 'powershell.exe';
    return { file: ps, args: [] };
  }
  // Launch the user's login shell interactively so rc files / aliases / prompt all apply.
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

async function openLocal(opts: OpenTermOptions): Promise<TermSession> {
  const mod: any = await loadPty();
  const spawn = mod?.default?.spawn ?? mod?.spawn;
  if (typeof spawn !== 'function') {
    opts.onError(
      'Local terminal needs the optional native module "node-pty", which is not installed.\r\n' +
        'Install it in your runtime, then restart:  npm install node-pty -w server\r\n' +
        '(SSH terminals work without it.)',
    );
    opts.onExit(null);
    return noopSession;
  }

  const { file, args } = pickShell();
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };

  let term: any;
  try {
    term = spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(opts.cols || 80, 1),
      rows: Math.max(opts.rows || 24, 1),
      cwd: os.homedir(),
      env,
    });
  } catch (e) {
    opts.onError(`failed to start shell: ${(e as Error).message}`);
    opts.onExit(null);
    return noopSession;
  }

  term.onData((d: string) => opts.onData(d));
  term.onExit((e: { exitCode: number }) => opts.onExit(e?.exitCode ?? null));

  return {
    write: (d) => { try { term.write(d); } catch { /* session gone */ } },
    resize: (c, r) => { try { term.resize(Math.max(c, 1), Math.max(r, 1)); } catch { /* swallow */ } },
    kill: () => { try { term.kill(); } catch { /* swallow */ } },
  };
}

// ---------------------------------------------------------------------------
// SSH interactive shell
// ---------------------------------------------------------------------------
function buildAuth(conn: Connection): Record<string, unknown> {
  if (!conn.secretRef) return {};
  const secret = getSecret(conn.secretRef);
  if (!secret) return {};
  if (conn.authType === 'privateKey') return { privateKey: secret };
  return { password: secret };
}

function openSsh(opts: OpenTermOptions): TermSession {
  const conn = opts.connection;
  if (conn.type !== 'ssh' || !conn.host) {
    opts.onError('connection is not an SSH connection');
    opts.onExit(null);
    return noopSession;
  }

  const client = new Client();
  let channel: ClientChannel | null = null;
  let killed = false;
  let exited = false;
  let exitCode: number | null = null;
  const finish = () => {
    if (exited) return;
    exited = true;
    opts.onExit(exitCode);
  };

  client.on('ready', () => {
    client.shell(
      { term: 'xterm-256color', cols: opts.cols || 80, rows: opts.rows || 24 },
      (err, ch) => {
        if (err) {
          opts.onError(`shell error: ${err.message}`);
          client.end();
          finish();
          return;
        }
        channel = ch;
        ch.on('data', (d: Buffer) => opts.onData(d.toString('utf8')));
        ch.stderr.on('data', (d: Buffer) => opts.onData(d.toString('utf8')));
        ch.on('exit', (code: number | null) => { exitCode = code ?? null; });
        ch.on('close', () => { client.end(); finish(); });
      },
    );
  });

  client.on('error', (err) => {
    opts.onError(`ssh error: ${err.message}`);
    if (!killed) finish();
  });
  client.on('close', () => finish());

  try {
    client.connect({
      host: conn.host,
      port: conn.port ?? 22,
      username: conn.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      ...buildAuth(conn),
    });
  } catch (e) {
    opts.onError(`ssh connect error: ${(e as Error).message}`);
    finish();
  }

  return {
    write: (d) => { try { channel?.write(d); } catch { /* swallow */ } },
    // ssh2 signature is setWindow(rows, cols, height, width)
    resize: (c, r) => { try { channel?.setWindow(Math.max(r, 1), Math.max(c, 1), 0, 0); } catch { /* swallow */ } },
    kill: () => {
      killed = true;
      try { channel?.close(); } catch { /* swallow */ }
      try { client.end(); } catch { /* swallow */ }
    },
  };
}

/** Open an interactive terminal for a connection (local PTY or remote SSH shell). */
export async function openTerminal(opts: OpenTermOptions): Promise<TermSession> {
  if (opts.connection.type === 'ssh') return openSsh(opts);
  return openLocal(opts);
}

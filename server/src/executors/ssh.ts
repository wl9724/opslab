import { Client, type ClientChannel } from 'ssh2';
import type { Connection } from '../types.js';
import { getSecret } from '../secrets.js';
import { resolveInterpreter } from './interpreters.js';

export interface SshRunOptions {
  connection: Connection;
  command: string;
  interpreter?: string;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onError: (err: Error) => void;
}

export interface SshRunHandle {
  kill: () => void;
}

function buildAuth(conn: Connection): Record<string, unknown> {
  if (!conn.secretRef) return {};
  const secret = getSecret(conn.secretRef);
  if (!secret) return {};
  if (conn.authType === 'privateKey') {
    return { privateKey: secret };
  }
  return { password: secret };
}

/** Quote a single arg for POSIX shells. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the remote command line for a given interpreter. */
function buildRemoteCommand(opts: SshRunOptions): { remoteCmd: string; stdinScript?: string } {
  const interp = resolveInterpreter(opts.interpreter ?? 'auto');
  if (!interp) {
    return { remoteCmd: opts.command };
  }
  if (interp.stdinFriendly) {
    // bash -s, python -, node - : feed script via stdin
    const stdinArg = interp.cmd === 'python' || interp.cmd === 'python3' || interp.cmd === 'node' || interp.cmd === 'ruby' || interp.cmd === 'perl' ? '-' : '-s';
    return {
      remoteCmd: `${shQuote(interp.cmd)} ${interp.args.map(shQuote).join(' ')} ${stdinArg}`.trim(),
      stdinScript: opts.command,
    };
  }
  // Non-stdin-friendly (e.g., powershell on remote): write to temp file then run
  const remoteTmp = `/tmp/opslab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${interp.ext}`;
  const encoded = Buffer.from(opts.command, 'utf8').toString('base64');
  const remoteCmd = [
    `echo ${shQuote(encoded)} | base64 -d > ${shQuote(remoteTmp)}`,
    `${shQuote(interp.cmd)} ${interp.args.map(shQuote).join(' ')} ${shQuote(remoteTmp)}`,
    `rm -f ${shQuote(remoteTmp)}`,
  ].join(' && ');
  return { remoteCmd };
}

export function runSsh(opts: SshRunOptions): SshRunHandle {
  const { connection } = opts;
  if (connection.type !== 'ssh' || !connection.host) {
    opts.onError(new Error('connection is not an SSH connection'));
    opts.onExit(null, null);
    return { kill: () => {} };
  }

  const client = new Client();
  let channel: ClientChannel | null = null;
  let killed = false;

  const { remoteCmd, stdinScript } = buildRemoteCommand(opts);

  client.on('ready', () => {
    client.exec(remoteCmd, { pty: stdinScript ? false : { term: 'xterm-256color' } }, (err, ch) => {
      if (err) {
        opts.onError(err);
        client.end();
        opts.onExit(null, null);
        return;
      }
      channel = ch;
      ch.on('data', (d: Buffer) => opts.onStdout(d.toString('utf8')));
      ch.stderr.on('data', (d: Buffer) => opts.onStderr(d.toString('utf8')));
      ch.on('close', (code: number | null, signal: string | null) => {
        client.end();
        opts.onExit(code ?? null, signal ?? null);
      });
      if (stdinScript) {
        ch.write(stdinScript);
        ch.end();
      }
    });
  });

  client.on('error', (err) => {
    opts.onError(err);
    if (!killed) opts.onExit(null, null);
  });

  try {
    client.connect({
      host: connection.host,
      port: connection.port ?? 22,
      username: connection.username,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
      ...buildAuth(connection),
    });
  } catch (e) {
    opts.onError(e as Error);
    opts.onExit(null, null);
  }

  return {
    kill: () => {
      killed = true;
      try {
        if (channel) channel.close();
        client.end();
      } catch {
        /* swallow */
      }
    },
  };
}

export function testSsh(connection: Connection): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (connection.type !== 'ssh' || !connection.host) {
      resolve({ ok: false, message: 'Not an SSH connection' });
      return;
    }
    const client = new Client();
    const timer = setTimeout(() => {
      try { client.end(); } catch { /* swallow */ }
      resolve({ ok: false, message: 'Timeout' });
    }, 15000);

    client.on('ready', () => {
      clearTimeout(timer);
      client.end();
      resolve({ ok: true, message: 'Connected' });
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    try {
      client.connect({
        host: connection.host,
        port: connection.port ?? 22,
        username: connection.username,
        readyTimeout: 10000,
        ...buildAuth(connection),
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, message: (e as Error).message });
    }
  });
}

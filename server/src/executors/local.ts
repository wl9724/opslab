import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInterpreter } from './interpreters.js';

export interface LocalRunHandle {
  proc: ChildProcess;
  kill: () => void;
}

export interface LocalRunOptions {
  command: string;
  /** If set and not 'auto', execute via this interpreter (writes a temp script). */
  interpreter?: string;
  cwd?: string;
  env?: Record<string, string>;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError: (err: Error) => void;
}

/** Prelude for PowerShell: UTF-8 output, no progress OSC noise, no error-action surprises. */
const PS_PRELUDE = `$ProgressPreference='SilentlyContinue'; ` +
                   `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ` +
                   `$ErrorActionPreference='Continue'; `;

function pickShell(): { shell: string; args: (cmd: string) => string[] } {
  if (process.platform === 'win32') {
    const ps = process.env.OPSLAB_WIN_SHELL ?? 'powershell.exe';
    if (ps.toLowerCase().includes('powershell') || ps.toLowerCase().includes('pwsh')) {
      return {
        shell: ps,
        args: (cmd) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_PRELUDE + cmd],
      };
    }
    return { shell: 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', cmd] };
  }
  // --norc + --noprofile: bulletproof against ANY shell config sourcing.
  //   Even though `-c` is non-interactive, BASH_ENV / ENV vars can still trigger sourcing
  //   of scripts that initialize Starship / Oh-My-Posh / shell-integration injectors,
  //   which spew OSC sequences into stdout. These flags disable all of it.
  return { shell: '/bin/bash', args: (cmd) => ['--norc', '--noprofile', '-c', cmd] };
}

/** Env vars to delete before spawning child shells.
 *
 * Two categories:
 *   1. Terminal/IDE injection markers — shell config files conditionally inject
 *      shell-integration code when these are set (VS Code, iTerm, Windows Terminal).
 *   2. Bash/zsh init-file hooks that bypass --norc/--noprofile (BASH_ENV runs even
 *      for non-interactive bash; ENV does the same for sh/dash).
 *   3. PROMPT_COMMAND and PS1..4 — even though prompts only print in interactive mode,
 *      some scripts evaluate PROMPT_COMMAND on startup. Best to scrub.
 */
const STRIP_ENV_VARS = [
  // IDE / terminal integration
  'VSCODE_INJECTION',
  'VSCODE_GIT_IPC_HANDLE',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_PID',
  'VSCODE_CWD',
  'VSCODE_NLS_CONFIG',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_STABLE',
  'VSCODE_L10N_BUNDLE_LOCATION',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'ITERM_PROFILE',
  'ITERM_SESSION_ID',
  'WT_SESSION',
  'WT_PROFILE_ID',
  'GIT_EDITOR',
  // Bash / sh init hooks
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'ZSH_DISABLE_COMPFIX',
  // Prompt strings (defensive)
  'PROMPT_COMMAND',
  'PROMPT_COMMAND_INTERACTIVE',
  'PROMPT_DIRTRIM',
  'PS0',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  // Common prompt-framework hints
  'STARSHIP_SHELL',
  'STARSHIP_SESSION_KEY',
  'POSH_SHELL',
  'POSH_SESSION_ID',
];

function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of STRIP_ENV_VARS) delete env[k];
  env.FORCE_COLOR = '1';
  // Override TERM so tools don't probe for fancy capabilities they think the host supports.
  // xterm-256color is safe — supports colors but no special vendor extensions.
  env.TERM = 'xterm-256color';
  return env;
}

function writeTempScript(body: string, ext: string, shebang?: string): string {
  const dir = path.join(os.tmpdir(), 'opslab-scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
  const content = shebang ? `${shebang}\n${body}` : body;
  fs.writeFileSync(file, content, { mode: 0o700 });
  return file;
}

function safeUnlink(p: string) {
  fs.promises.unlink(p).catch(() => { /* swallow */ });
}

export function runLocal(opts: LocalRunOptions): LocalRunHandle {
  const env = cleanEnv(opts.env);
  const interp = resolveInterpreter(opts.interpreter ?? 'auto');

  let proc: ChildProcess;
  let cleanup: (() => void) | undefined;

  if (!interp) {
    // Default: pass whole template to OS shell
    const { shell, args } = pickShell();
    proc = spawn(shell, args(opts.command), {
      cwd: opts.cwd ?? os.homedir(),
      env,
      windowsHide: true,
    });
  } else {
    // Script mode: write temp file and execute with interpreter
    const file = writeTempScript(opts.command, interp.ext, interp.shebang);
    cleanup = () => safeUnlink(file);
    proc = spawn(interp.cmd, [...interp.args, file], {
      cwd: opts.cwd ?? os.homedir(),
      env,
      windowsHide: true,
    });
  }

  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');

  proc.stdout?.on('data', (d: string) => opts.onStdout(d));
  proc.stderr?.on('data', (d: string) => opts.onStderr(d));
  proc.on('error', (err) => opts.onError(err));
  proc.on('close', (code, signal) => {
    cleanup?.();
    opts.onExit(code, signal);
  });

  return {
    proc,
    kill: () => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 2000);
      }
    },
  };
}

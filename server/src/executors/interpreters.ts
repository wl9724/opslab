/** Interpreter helpers shared by local + ssh executors. */

export interface InterpreterSpec {
  /** What to invoke. May be a bare name (resolved via PATH) or absolute path. */
  cmd: string;
  /** Args BEFORE the script path/stdin marker. */
  args: string[];
  /** File extension to use when writing the script to a temp file. */
  ext: string;
  /** If true, prefer piping the script via stdin (uses '-' arg). */
  stdinFriendly: boolean;
  /** Optional shebang inserted at top of temp file. */
  shebang?: string;
}

const TABLE: Record<string, InterpreterSpec> = {
  bash:       { cmd: 'bash',       args: [],        ext: '.sh',  stdinFriendly: true,  shebang: '#!/usr/bin/env bash' },
  sh:         { cmd: 'sh',         args: [],        ext: '.sh',  stdinFriendly: true,  shebang: '#!/usr/bin/env sh' },
  zsh:        { cmd: 'zsh',        args: [],        ext: '.sh',  stdinFriendly: true,  shebang: '#!/usr/bin/env zsh' },
  powershell: { cmd: 'powershell', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'], ext: '.ps1', stdinFriendly: false },
  pwsh:       { cmd: 'pwsh',       args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File'], ext: '.ps1', stdinFriendly: false },
  python:     { cmd: 'python',     args: [],        ext: '.py',  stdinFriendly: true,  shebang: '#!/usr/bin/env python' },
  python3:    { cmd: 'python3',    args: [],        ext: '.py',  stdinFriendly: true,  shebang: '#!/usr/bin/env python3' },
  node:       { cmd: 'node',       args: [],        ext: '.js',  stdinFriendly: true,  shebang: '#!/usr/bin/env node' },
  ruby:       { cmd: 'ruby',       args: [],        ext: '.rb',  stdinFriendly: true,  shebang: '#!/usr/bin/env ruby' },
  perl:       { cmd: 'perl',       args: [],        ext: '.pl',  stdinFriendly: true,  shebang: '#!/usr/bin/env perl' },
};

/** Resolve interpreter name to a spec. Unknown strings are treated as a custom command path. */
export function resolveInterpreter(name: string): InterpreterSpec | null {
  if (!name || name === 'auto') return null;
  const lower = name.toLowerCase();
  if (TABLE[lower]) return TABLE[lower];
  // Custom interpreter: treat as bare command, write to .txt, pass file path
  return { cmd: name, args: [], ext: '.txt', stdinFriendly: false };
}

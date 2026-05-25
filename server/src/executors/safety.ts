export interface SafetyResult {
  level: 'safe' | 'warning' | 'danger';
  reasons: string[];
}

const DANGER_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(\s|$)/, reason: 'rm targeting root /' },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\//, reason: 'rm -rf on root path' },
  { re: /\bmkfs(\.|\s)/, reason: 'filesystem format (mkfs)' },
  { re: /\bdd\s+.*\bof=\/dev\//, reason: 'dd writing to a device' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: 'fork bomb' },
  { re: /\bshutdown\b/i, reason: 'system shutdown' },
  { re: /\breboot\b/i, reason: 'system reboot' },
  { re: /\bhalt\b/i, reason: 'system halt' },
  { re: /\bformat\s+[a-zA-Z]:/i, reason: 'Windows disk format' },
  { re: /Remove-Item\s+.*-Recurse\s+.*-Force\s+(C:\\|\/)/i, reason: 'PowerShell recursive force delete on root' },
  { re: /\bchmod\s+-R?\s*777\s+\//, reason: 'chmod 777 on root' },
  { re: />\s*\/dev\/sd[a-z]/, reason: 'writing to raw disk device' },
];

const WARN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b/, reason: 'sudo usage' },
  { re: /\brm\s+-[a-zA-Z]*r/, reason: 'recursive rm' },
  { re: /\bdrop\s+(table|database)/i, reason: 'SQL DROP statement' },
  { re: /\btruncate\s+table/i, reason: 'SQL TRUNCATE' },
  { re: /\bkubectl\s+delete\b/, reason: 'kubectl delete' },
  { re: /\bdocker\s+(rm|rmi)\s+-f/, reason: 'forced docker remove' },
  { re: /\bgit\s+push\s+.*--force\b/, reason: 'forced git push' },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard' },
  { re: />\s*[^>\s]+/, reason: 'output redirection (may overwrite)' },
];

export function checkSafety(cmd: string): SafetyResult {
  const reasons: string[] = [];
  let level: SafetyResult['level'] = 'safe';
  for (const { re, reason } of DANGER_PATTERNS) {
    if (re.test(cmd)) {
      reasons.push(reason);
      level = 'danger';
    }
  }
  if (level !== 'danger') {
    for (const { re, reason } of WARN_PATTERNS) {
      if (re.test(cmd)) {
        reasons.push(reason);
        level = 'warning';
      }
    }
  }
  return { level, reasons };
}

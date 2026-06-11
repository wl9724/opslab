/**
 * In-memory debug log for the whole server.
 *
 * Design goals:
 *   - Zero persistence: this is a live troubleshooting aid, not an audit trail
 *     (execution output already lands in data/outputs/). A bounded ring buffer
 *     keeps memory flat no matter how long the server runs.
 *   - `debug` level is opt-in: entries are recorded only while debug mode is on
 *     (OPSLAB_DEBUG=1 at boot, or toggled at runtime from the 调试 page).
 *     info/warn/error are always recorded — they're cheap and most useful
 *     exactly when you didn't think to enable debug beforehand.
 *   - Never log secrets: callers pass metadata (host, user, model, byte counts),
 *     never passwords / private keys / API keys.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic id — lets clients fetch "everything after what I already have". */
  id: number;
  /** Epoch ms. */
  ts: number;
  level: LogLevel;
  /** Subsystem tag: http / socket / runner / ssh / term / ai / playbook / system … */
  scope: string;
  msg: string;
  /** Optional structured detail, already serialized (and truncated). */
  detail?: string;
}

const MAX_ENTRIES = 2000;
const MAX_MSG_LEN = 500;
const MAX_DETAIL_LEN = 4096;

const entries: LogEntry[] = [];
let nextId = 1;
let debugEnabled = process.env.OPSLAB_DEBUG === '1';

type LogSubscriber = (entry: LogEntry) => void;
const subscribers = new Set<LogSubscriber>();

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

/** Serialize arbitrary detail safely (circular refs, Errors, BigInt won't throw). */
function serializeDetail(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return truncate(detail, MAX_DETAIL_LEN);
  if (detail instanceof Error) return truncate(detail.stack ?? detail.message, MAX_DETAIL_LEN);
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      detail,
      (_k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        return v;
      },
      2,
    );
    return truncate(json ?? String(detail), MAX_DETAIL_LEN);
  } catch {
    return truncate(String(detail), MAX_DETAIL_LEN);
  }
}

function consoleEcho(e: LogEntry) {
  // warn/error always reach the terminal; debug/info only while debug mode is on,
  // so a quiet server stays quiet.
  if (LEVEL_RANK[e.level] < LEVEL_RANK.warn && !debugEnabled) return;
  const time = new Date(e.ts).toISOString().slice(11, 23);
  const line = `[${time}] ${e.level.toUpperCase().padEnd(5)} ${e.scope.padEnd(8)} ${e.msg}${e.detail ? ` — ${e.detail.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
  if (e.level === 'error') console.error(line);
  else if (e.level === 'warn') console.warn(line);
  else console.log(line);
}

function record(level: LogLevel, scope: string, msg: string, detail?: unknown): void {
  if (level === 'debug' && !debugEnabled) return;
  const entry: LogEntry = {
    id: nextId++,
    ts: Date.now(),
    level,
    scope,
    msg: truncate(msg, MAX_MSG_LEN),
    detail: serializeDetail(detail),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  consoleEcho(entry);
  for (const fn of subscribers) {
    try { fn(entry); } catch { /* swallow */ }
  }
}

export interface Logger {
  debug(msg: string, detail?: unknown): void;
  info(msg: string, detail?: unknown): void;
  warn(msg: string, detail?: unknown): void;
  error(msg: string, detail?: unknown): void;
}

/** Scoped logger — `const log = createLogger('ssh'); log.debug('connecting', {...})`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (msg, detail) => record('debug', scope, msg, detail),
    info: (msg, detail) => record('info', scope, msg, detail),
    warn: (msg, detail) => record('warn', scope, msg, detail),
    error: (msg, detail) => record('error', scope, msg, detail),
  };
}

/** Live-stream every recorded entry (used to push `debug-log` socket events). */
export function onLog(fn: LogSubscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugEnabled(enabled: boolean): void {
  if (debugEnabled === enabled) return;
  debugEnabled = enabled;
  record('info', 'system', `调试模式已${enabled ? '开启' : '关闭'}`);
}

export interface LogQuery {
  /** Minimum level to include (e.g. 'info' hides debug). */
  minLevel?: LogLevel;
  /** Only this scope. */
  scope?: string;
  /** Case-insensitive substring match against msg + detail. */
  q?: string;
  /** Only entries with id > afterId (incremental polling). */
  afterId?: number;
  limit?: number;
}

export function queryLogs(query: LogQuery = {}): { entries: LogEntry[]; total: number } {
  const minRank = LEVEL_RANK[query.minLevel ?? 'debug'];
  const needle = query.q?.toLowerCase();
  let out = entries.filter((e) => {
    if (LEVEL_RANK[e.level] < minRank) return false;
    if (query.scope && e.scope !== query.scope) return false;
    if (query.afterId !== undefined && e.id <= query.afterId) return false;
    if (needle && !e.msg.toLowerCase().includes(needle) && !(e.detail?.toLowerCase().includes(needle))) return false;
    return true;
  });
  const total = out.length;
  const limit = Math.min(Math.max(query.limit ?? 500, 1), MAX_ENTRIES);
  if (out.length > limit) out = out.slice(out.length - limit);
  return { entries: out, total };
}

/** Distinct scopes seen so far (for the filter dropdown). */
export function knownScopes(): string[] {
  return [...new Set(entries.map((e) => e.scope))].sort();
}

export function clearLogs(): number {
  const n = entries.length;
  entries.length = 0;
  record('info', 'system', `日志已清空（${n} 条）`);
  return n;
}

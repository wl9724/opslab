import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { subscribeDebugLogs } from '../lib/socket';
import type { DebugLogEntry, DebugLogLevel, DebugState } from '../lib/types';

const MAX_CLIENT_ENTRIES = 2000;

const LEVEL_BADGE: Record<DebugLogLevel, string> = {
  debug: 'text-ink-400 border-ink-700',
  info: 'text-sky-300 border-sky-800',
  warn: 'text-amber-300 border-amber-800',
  error: 'text-red-300 border-red-800',
};

const LEVEL_OPTIONS: Array<{ value: '' | DebugLogLevel; label: string }> = [
  { value: '', label: '全部级别' },
  { value: 'debug', label: 'debug+' },
  { value: 'info', label: 'info+' },
  { value: 'warn', label: 'warn+' },
  { value: 'error', label: 'error' },
];

const LEVEL_RANK: Record<DebugLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function StateCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-ink-900 border border-ink-800 rounded px-3 py-2 min-w-28">
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className="text-sm text-ink-100 font-mono mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-ink-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function Debug() {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [state, setState] = useState<DebugState | null>(null);
  const [debugEnabled, setDebugEnabledState] = useState(false);
  const [level, setLevel] = useState<'' | DebugLogLevel>('');
  const [scope, setScope] = useState('');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const pausedRef = useRef(false);
  const pendingRef = useRef<DebugLogEntry[]>([]);

  pausedRef.current = paused;

  const appendEntries = useCallback((incoming: DebugLogEntry[]) => {
    if (incoming.length === 0) return;
    setEntries((prev) => {
      const merged = [...prev, ...incoming];
      // The server can replay ids we already have (REST load + live stream race) — dedup by id.
      const seen = new Set<number>();
      const out = merged.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      return out.length > MAX_CLIENT_ENTRIES ? out.slice(out.length - MAX_CLIENT_ENTRIES) : out;
    });
    setScopes((prev) => {
      const s = new Set(prev);
      for (const e of incoming) s.add(e.scope);
      return s.size === prev.length ? prev : [...s].sort();
    });
  }, []);

  // Initial load + live stream.
  useEffect(() => {
    let disposed = false;
    api.debugLogs({ limit: 500 }).then((r) => {
      if (disposed) return;
      setDebugEnabledState(r.debugEnabled);
      setScopes(r.scopes);
      appendEntries(r.entries);
    });
    const unsub = subscribeDebugLogs((entry) => {
      if (pausedRef.current) {
        pendingRef.current.push(entry);
        setPendingCount(pendingRef.current.length);
      } else {
        appendEntries([entry]);
      }
    });
    return () => {
      disposed = true;
      unsub();
    };
  }, [appendEntries]);

  // Runtime state panel, refreshed every 5s.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.debugState().then((s) => {
        if (!alive) return;
        setState(s);
        setDebugEnabledState(s.debugEnabled);
      }).catch(() => { /* server gone — banner already shows the error */ });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const filtered = useMemo(() => {
    const minRank = level ? LEVEL_RANK[level] : 0;
    const needle = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (LEVEL_RANK[e.level] < minRank) return false;
      if (scope && e.scope !== scope) return false;
      if (needle && !e.msg.toLowerCase().includes(needle) && !(e.detail?.toLowerCase().includes(needle)))
        return false;
      return true;
    });
  }, [entries, level, scope, search]);

  // Stick to bottom unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [filtered]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  function togglePause() {
    if (paused) {
      appendEntries(pendingRef.current);
      pendingRef.current = [];
      setPendingCount(0);
    }
    setPaused(!paused);
  }

  async function toggleDebugMode() {
    const r = await api.setDebugEnabled(!debugEnabled);
    setDebugEnabledState(r.debugEnabled);
  }

  async function clearAll() {
    await api.clearDebugLogs();
    pendingRef.current = [];
    setPendingCount(0);
    setEntries([]);
    setExpanded(new Set());
  }

  function exportLogs() {
    const text = filtered
      .map((e) => `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase().padEnd(5)} ${e.scope.padEnd(8)} ${e.msg}${e.detail ? `\n${e.detail}` : ''}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `opslab-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-ink-800">
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">调试</h1>
            <div className="text-xs text-ink-500">服务端运行状态与实时日志</div>
          </div>
          <button
            onClick={toggleDebugMode}
            className={`ml-auto px-3 py-1.5 rounded text-sm border transition-colors ${
              debugEnabled
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-700'
                : 'bg-ink-900 text-ink-300 border-ink-700 hover:bg-ink-800'
            }`}
          >
            调试模式：{debugEnabled ? '开' : '关'}
          </button>
        </div>
        {!debugEnabled && (
          <div className="mt-2 text-xs text-ink-500">
            调试模式关闭时仅记录 info / warn / error；开启后额外记录 debug 明细（HTTP 请求、命令原始输出、SSH/终端会话事件等），也可启动时设
            <code className="mx-1 text-ink-300">OPSLAB_DEBUG=1</code>。
          </div>
        )}
        {state && (
          <div className="flex gap-2 mt-3 flex-wrap">
            <StateCard label="版本" value={`v${state.version}`} sub={`${state.node} · ${state.platform}`} />
            <StateCard label="运行时长" value={fmtUptime(state.uptimeSec)} sub={`pid ${state.pid}`} />
            <StateCard
              label="内存 (RSS)"
              value={fmtBytes(state.memory.rss)}
              sub={`heap ${fmtBytes(state.memory.heapUsed)} / ${fmtBytes(state.memory.heapTotal)}`}
            />
            <StateCard label="活跃执行" value={String(state.activeRuns)} />
            <StateCard
              label="终端会话"
              value={String(state.termSessions.length)}
              sub={state.termSessions.length > 0 ? `${state.termSessions.filter((t) => t.attached).length} 个已连接` : undefined}
            />
            <StateCard label="Socket 连接" value={String(state.socketClients ?? '—')} />
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-b border-ink-800 flex items-center gap-2 flex-wrap">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as '' | DebugLogLevel)}
          className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm"
        >
          {LEVEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm"
        >
          <option value="">全部模块</option>
          {scopes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索消息 / 明细…"
          className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-sm flex-1 min-w-40"
        />
        <span className="text-xs text-ink-500">{filtered.length} / {entries.length} 条</span>
        <button
          onClick={togglePause}
          className="px-2.5 py-1 rounded text-sm border border-ink-700 bg-ink-900 text-ink-300 hover:bg-ink-800"
        >
          {paused ? `▶ 继续${pendingCount > 0 ? ` (+${pendingCount})` : ''}` : '⏸ 暂停'}
        </button>
        <button
          onClick={exportLogs}
          className="px-2.5 py-1 rounded text-sm border border-ink-700 bg-ink-900 text-ink-300 hover:bg-ink-800"
        >
          ⤓ 导出
        </button>
        <button
          onClick={clearAll}
          className="px-2.5 py-1 rounded text-sm border border-ink-700 bg-ink-900 text-red-300 hover:bg-ink-800"
        >
          清空
        </button>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="p-6 text-ink-500 text-sm font-sans">
            暂无日志。执行命令、连接 SSH、调用 AI 后这里会实时出现对应记录。
          </div>
        ) : (
          filtered.map((e) => (
            <div
              key={e.id}
              onClick={() => e.detail && toggleExpand(e.id)}
              className={`px-4 py-1 border-b border-ink-900 hover:bg-ink-900/60 ${e.detail ? 'cursor-pointer' : ''}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-ink-600 shrink-0">{fmtTime(e.ts)}</span>
                <span className={`shrink-0 border rounded px-1 leading-4 ${LEVEL_BADGE[e.level]}`}>
                  {e.level.toUpperCase()}
                </span>
                <span className="text-emerald-300/80 shrink-0 w-16 truncate">{e.scope}</span>
                <span className="text-ink-200 break-all">{e.msg}</span>
                {e.detail && (
                  <span className="text-ink-600 ml-auto shrink-0">{expanded.has(e.id) ? '▾' : '▸'}</span>
                )}
              </div>
              {e.detail && expanded.has(e.id) && (
                <pre className="mt-1 mb-1 ml-24 bg-[#0b1220] border border-ink-800 rounded p-2 text-ink-300 whitespace-pre-wrap break-all max-h-64 overflow-auto">
                  {e.detail}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

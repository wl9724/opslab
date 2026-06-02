import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { openTerminal, type TerminalController } from '../lib/socket';
import { TerminalView, type TerminalHandle } from '../components/TerminalView';

type TermStatus = 'connecting' | 'connected' | 'closed';

interface Tab {
  id: string;
  connectionId: string;
  status: TermStatus;
}

function tabId() {
  return Math.random().toString(36).slice(2, 8);
}

function StatusDot({ status }: { status: TermStatus }) {
  const cls =
    status === 'connected' ? 'bg-emerald-400' :
    status === 'connecting' ? 'bg-sky-400 animate-pulse' :
    'bg-red-400';
  return <span className={`w-1.5 h-1.5 rounded-full ${cls}`} />;
}

/**
 * One interactive PTY session bound to a connection. Kept mounted across tab switches
 * (parent toggles `display`) so a background shell keeps running while you work elsewhere.
 */
function TerminalPane({
  connectionId,
  active,
  onConnectionChange,
  onStatusChange,
}: {
  connectionId: string;
  active: boolean;
  onConnectionChange: (id: string) => void;
  onStatusChange: (s: TermStatus) => void;
}) {
  const connections = useStore((s) => s.connections);
  const termRef = useRef<TerminalHandle | null>(null);
  const ctrlRef = useRef<TerminalController | null>(null);
  const dimsRef = useRef({ cols: 80, rows: 24 });
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [generation, setGeneration] = useState(0);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onStatusChangeRef.current(status); }, [status]);

  // (Re)open the session whenever the target connection changes or a reconnect is requested.
  useEffect(() => {
    setStatus('connecting');
    termRef.current?.clear();
    let gotData = false;
    const ctrl = openTerminal({
      connectionId: connectionId || undefined,
      cols: dimsRef.current.cols,
      rows: dimsRef.current.rows,
      onData: (data) => {
        if (!gotData) { gotData = true; setStatus('connected'); }
        termRef.current?.write(data);
      },
      onExit: (code) => {
        setStatus('closed');
        termRef.current?.write(`\r\n\x1b[90m[会话结束${code != null ? ` · exit ${code}` : ''}]\x1b[0m\r\n`);
      },
    });
    ctrlRef.current = ctrl;
    const focusTimer = setTimeout(() => termRef.current?.focus(), 60);
    return () => {
      clearTimeout(focusTimer);
      ctrl.close();
      ctrlRef.current = null;
    };
  }, [connectionId, generation]);

  // Focus the terminal when this tab becomes the active one.
  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  const handleData = useCallback((data: string) => {
    ctrlRef.current?.input(data);
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    dimsRef.current = { cols, rows };
    ctrlRef.current?.resize(cols, rows);
  }, []);

  const conn = connections.find((c) => c.id === connectionId);
  const target = conn?.type === 'ssh'
    ? `${conn.username ?? ''}@${conn.host ?? ''}`
    : '本地 shell';

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-ink-800 bg-ink-900 text-xs">
        <span className="text-ink-400">连接</span>
        <select
          value={connectionId}
          onChange={(e) => onConnectionChange(e.target.value)}
          className="bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
          title="切换连接会重开会话"
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name} · {c.type}</option>
          ))}
        </select>
        <StatusDot status={status} />
        <span className={
          status === 'connected' ? 'text-emerald-400' :
          status === 'connecting' ? 'text-sky-400' :
          'text-red-400'
        }>
          {status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '已断开'}
        </span>
        {status === 'closed' && (
          <button
            onClick={() => setGeneration((g) => g + 1)}
            className="ml-1 px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white"
          >重新连接</button>
        )}
        <span className="ml-auto text-ink-600 truncate max-w-[40%]">{target}</span>
      </div>
      <div className="flex-1 min-h-0 p-1">
        <TerminalView
          ref={termRef}
          interactive
          onData={handleData}
          onResize={handleResize}
          downloadName={`opslab-term-${conn?.name ?? 'session'}.log`}
        />
      </div>
    </div>
  );
}

export function WebTerminal() {
  const connections = useStore((s) => s.connections);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  const defaultConnId = useMemo(() => {
    const local = connections.find((c) => c.type === 'local');
    return local?.id ?? connections[0]?.id ?? '';
  }, [connections]);

  // Create the first tab once connections have loaded (so the default connection is correct).
  useEffect(() => {
    if (tabs.length === 0 && connections.length > 0) {
      const t: Tab = { id: tabId(), connectionId: defaultConnId, status: 'connecting' };
      setTabs([t]);
      setActiveId(t.id);
    }
  }, [connections.length, defaultConnId, tabs.length]);

  function addTab() {
    const t: Tab = { id: tabId(), connectionId: defaultConnId, status: 'connecting' };
    setTabs((cur) => [...cur, t]);
    setActiveId(t.id);
  }

  function closeTab(id: string) {
    setTabs((cur) => {
      const next = cur.filter((t) => t.id !== id);
      if (id === activeId && next.length > 0) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  function updateTab(id: string, patch: Partial<Tab>) {
    setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  const nameFor = (connectionId: string) =>
    connections.find((c) => c.id === connectionId)?.name ?? '终端';

  if (connections.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-ink-500 text-sm">
        加载连接中…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center bg-ink-950 border-b border-ink-800 px-2">
        <div className="flex overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2 px-3 py-2 border-r border-ink-800 cursor-pointer text-sm whitespace-nowrap ${activeId === t.id ? 'bg-ink-900 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
              onClick={() => setActiveId(t.id)}
            >
              <StatusDot status={t.status} />
              <span className="max-w-[160px] truncate">{nameFor(t.connectionId)}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                className="text-ink-600 hover:text-ink-200"
                title="关闭会话"
              >×</button>
            </div>
          ))}
        </div>
        <button
          onClick={addTab}
          className="px-3 py-1 ml-2 text-ink-400 hover:text-emerald-300 text-lg leading-none"
          title="新建终端"
        >+</button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-ink-500 text-sm">
            点 + 新建终端会话
          </div>
        ) : (
          tabs.map((t) => (
            <div key={t.id} className="absolute inset-0" style={{ display: activeId === t.id ? 'block' : 'none' }}>
              <TerminalPane
                connectionId={t.connectionId}
                active={activeId === t.id}
                onConnectionChange={(id) => updateTab(t.id, { connectionId: id })}
                onStatusChange={(status) => updateTab(t.id, { status })}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

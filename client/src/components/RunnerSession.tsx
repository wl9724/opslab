import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, extractVars } from '../lib/api';
import { useStore } from '../lib/store';
import { subscribeRun } from '../lib/socket';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { VariableForm } from './VariableForm';
import { stripNoise } from '../lib/ansi';
import type { CommandTemplate, Connection, SafetyResult } from '../lib/types';

interface PanelState {
  connectionId: string;
  connectionName: string;
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'idle';
  exitCode: number | null;
}

export interface RunnerSessionProps {
  initialCommandId?: string;
  /** called when something inside changes that should affect the tab title */
  onTitleChange?: (title: string) => void;
  /** called when status changes (so tab can show a dot) */
  onStatusChange?: (status: 'idle' | 'running' | 'completed' | 'failed') => void;
}

export function RunnerSession({ initialCommandId, onTitleChange, onStatusChange }: RunnerSessionProps) {
  const navigate = useNavigate();
  const commands = useStore((s) => s.commands);
  const connections = useStore((s) => s.connections);

  const [commandId, setCommandId] = useState<string | undefined>(initialCommandId);
  const command: CommandTemplate | undefined = useMemo(
    () => commands.find((c) => c.id === commandId),
    [commandId, commands],
  );

  const [template, setTemplate] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedConnIds, setSelectedConnIds] = useState<string[]>([]);
  const [panels, setPanels] = useState<PanelState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyResult | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const termRefs = useRef<Record<string, TerminalHandle | null>>({});

  // Keep latest callback refs so we don't have to put unstable function props in effect deps
  // (parent passes inline arrows → new identity every render → infinite loop if used as dep).
  const onTitleChangeRef = useRef(onTitleChange);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; }, [onTitleChange]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  // 1. When command changes, seed template + default var values
  useEffect(() => {
    if (!command) return;
    setTemplate(command.template);
    const def: Record<string, string> = {};
    for (const v of command.vars) if (v.defaultValue) def[v.name] = v.defaultValue;
    setValues(def);
  }, [command]);

  // 2. Auto-pick a connection if none chosen yet
  useEffect(() => {
    if (selectedConnIds.length > 0) return;
    if (connections.length === 0) return;
    if (command) {
      const candidates = connections.filter((c) => (command.targetType === 'ssh' ? c.type === 'ssh' : true));
      if (candidates.length > 0) setSelectedConnIds([candidates[0].id]);
    } else {
      const local = connections.find((c) => c.type === 'local');
      if (local) setSelectedConnIds([local.id]);
    }
    // We only run when there's no selection yet; intentionally not in deps to avoid re-pick on every connections refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, commandId, connections.length]);

  // 3. Derived tab title — notify parent only when it actually changes
  const sessionTitle = command?.name ?? '临时命令';
  useEffect(() => {
    onTitleChangeRef.current?.(sessionTitle);
  }, [sessionTitle]);

  const adhocVars = useMemo(() => extractVars(template), [template]);
  const targetConnections: Connection[] = useMemo(
    () => connections.filter((c) => {
      if (!command) return true;
      if (command.targetType === 'ssh') return c.type === 'ssh';
      return true;
    }),
    [connections, command],
  );

  // 4. Derived session status — single value, fires only on real change
  const sessionStatus: 'idle' | 'running' | 'completed' | 'failed' = useMemo(() => {
    if (panels.length === 0) return 'idle';
    if (panels.some((p) => p.status === 'running')) return 'running';
    if (panels.some((p) => p.status === 'failed' || p.status === 'killed')) return 'failed';
    return 'completed';
  }, [panels]);
  useEffect(() => {
    onStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);
  const anyRunning = sessionStatus === 'running';

  function toggleConn(id: string) {
    setSelectedConnIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function run(confirmDanger = false) {
    setError(null);
    setSafety(null);
    setPendingConfirm(null);

    if (selectedConnIds.length === 0) {
      setError('请至少选一个目标连接');
      return;
    }

    try {
      let newPanels: PanelState[];
      if (selectedConnIds.length === 1) {
        const res = await api.run({
          commandId: command?.id,
          connectionId: selectedConnIds[0],
          template: command ? undefined : template,
          values,
          confirmDanger,
        });
        const conn = connections.find((c) => c.id === selectedConnIds[0])!;
        newPanels = [{
          connectionId: conn.id,
          connectionName: conn.name,
          executionId: res.execution.id,
          status: 'running',
          exitCode: null,
        }];
        setSafety(res.safety);
      } else {
        const res = await api.fanout({
          commandId: command?.id,
          template: command ? undefined : template,
          connectionIds: selectedConnIds,
          values,
          confirmDanger,
        });
        newPanels = res.results.map((r) => {
          const conn = connections.find((c) => c.id === r.connectionId);
          if (r.ok) {
            return {
              connectionId: r.connectionId,
              connectionName: conn?.name ?? r.connectionId,
              executionId: r.execution.id,
              status: 'running' as const,
              exitCode: null,
            };
          }
          return {
            connectionId: r.connectionId,
            connectionName: conn?.name ?? r.connectionId,
            executionId: 'error-' + r.connectionId,
            status: 'failed' as const,
            exitCode: null,
          };
        });
      }
      setPanels(newPanels);
      // Clear and write prompt
      setTimeout(() => {
        for (const p of newPanels) {
          const t = termRefs.current[p.executionId];
          t?.clear();
          if (p.status === 'failed') {
            t?.writeln(`\x1b[91m[opslab] failed to start on ${p.connectionName}\x1b[0m`);
          }
        }
      }, 0);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('dangerous command blocked')) {
        setPendingConfirm(msg);
      } else {
        setError(msg);
      }
    }
  }

  async function stopAll() {
    for (const p of panels) {
      if (p.status === 'running') {
        api.stop(p.executionId).catch(() => {});
      }
    }
  }

  // Subscribe to all running executions
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    for (const p of panels) {
      if (p.status !== 'running') continue;
      const t = termRefs.current[p.executionId];
      const debug = new URLSearchParams(window.location.search).get('debug') === '1';
      const unsub = subscribeRun(p.executionId, (ev) => {
        if (ev.type === 'chunk') {
          if (debug) {
            // eslint-disable-next-line no-console
            console.log(`[opslab WS ${ev.stream}]`, JSON.stringify(ev.data));
          }
          const clean = stripNoise(ev.data);
          if (!clean) return;
          if (debug && clean !== ev.data) {
            // eslint-disable-next-line no-console
            console.log(`[opslab clean ${ev.stream}]`, JSON.stringify(clean));
          }
          if (ev.stream === 'stderr') t?.write(`\x1b[91m${clean}\x1b[0m`);
          else t?.write(clean);
        } else if (ev.type === 'done') {
          t?.writeln(`\r\n\x1b[90m[exit ${ev.exitCode ?? '—'} · ${ev.status}]\x1b[0m`);
          setPanels((cur) => cur.map((x) => x.executionId === p.executionId ? { ...x, status: ev.status as any, exitCode: ev.exitCode } : x));
        }
      });
      unsubs.push(unsub);
    }
    return () => unsubs.forEach((u) => u());
  }, [panels.map((p) => `${p.executionId}:${p.status}`).join('|')]);

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-ink-800 p-4 overflow-auto">
        <div className="mb-3">
          <div className="text-xs text-ink-300 mb-1">命令</div>
          <select
            value={commandId ?? '__adhoc__'}
            onChange={(e) => setCommandId(e.target.value === '__adhoc__' ? undefined : e.target.value)}
            className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
          >
            <option value="__adhoc__">— 临时命令 —</option>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {command && (
            <button
              onClick={() => navigate(`/commands/${command.id}`)}
              className="mt-1 text-xs text-ink-400 hover:text-emerald-300"
            >编辑命令模板 →</button>
          )}
        </div>

        <div className="mb-3">
          <div className="text-xs text-ink-300 mb-1 flex items-center gap-2">
            <span>目标连接</span>
            <span className="text-ink-500">{selectedConnIds.length > 1 ? `(fan-out: ${selectedConnIds.length} 台)` : ''}</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-auto">
            {targetConnections.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-ink-800/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedConnIds.includes(c.id)}
                  onChange={() => toggleConn(c.id)}
                  className="accent-emerald-500"
                />
                <span>{c.name}</span>
                <span className="ml-auto text-xs text-ink-500">{c.type}</span>
              </label>
            ))}
          </div>
        </div>

        {!command && (
          <div className="mb-3">
            <div className="text-xs text-ink-300 mb-1">模板</div>
            <textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={4}
              className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-xs font-mono"
              placeholder="echo hello"
            />
          </div>
        )}

        <div className="mb-3">
          <div className="text-xs text-ink-300 mb-1">变量</div>
          {command ? (
            <VariableForm vars={command.vars} values={values} onChange={setValues} />
          ) : adhocVars.length > 0 ? (
            <VariableForm
              vars={adhocVars.map((n) => ({ name: n, label: n, type: 'text', required: true }))}
              values={values}
              onChange={setValues}
            />
          ) : (
            <div className="text-xs text-ink-500">无变量</div>
          )}
        </div>

        {error && <div className="mb-3 text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded p-2">{error}</div>}

        {pendingConfirm && (
          <div className="mb-3 bg-red-950/60 border border-red-800 rounded p-2 text-xs">
            <div className="text-red-300 font-medium mb-1">⚠ 高危命令</div>
            <div className="text-red-200 mb-2">{pendingConfirm}</div>
            <div className="flex gap-2">
              <button onClick={() => run(true)} className="flex-1 px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-white">我已确认</button>
              <button onClick={() => setPendingConfirm(null)} className="flex-1 px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded">取消</button>
            </div>
          </div>
        )}

        {safety && safety.level === 'warning' && (
          <div className="mb-3 bg-amber-950/40 border border-amber-900/60 rounded p-2 text-xs text-amber-200">
            注意：{safety.reasons.join('; ')}
          </div>
        )}

        <div className="flex gap-2">
          {anyRunning ? (
            <button onClick={stopAll} className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-500 rounded text-sm font-medium">■ 停止全部</button>
          ) : (
            <button onClick={() => run(false)} className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium">▶ 执行</button>
          )}
        </div>
      </div>

      <div className="flex-1 p-2">
        {panels.length === 0 ? (
          <div className="h-full flex items-center justify-center text-ink-500 text-sm">
            选好目标和参数后点 ▶ 执行
          </div>
        ) : (
          <div
            className="h-full grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${Math.min(panels.length, panels.length === 1 ? 1 : 2)}, minmax(0, 1fr))`,
              gridAutoRows: panels.length > 2 ? 'minmax(0, 1fr)' : 'minmax(0, 1fr)',
            }}
          >
            {panels.map((p) => (
              <div key={p.executionId} className="flex flex-col bg-[#0b1220] rounded border border-ink-800 overflow-hidden min-h-0">
                <div className="px-2 py-1 text-xs flex items-center gap-2 border-b border-ink-800 bg-ink-900">
                  <span className="font-medium">{p.connectionName}</span>
                  <span className={
                    p.status === 'running' ? 'text-sky-400' :
                    p.status === 'completed' ? 'text-emerald-400' :
                    p.status === 'failed' ? 'text-red-400' :
                    p.status === 'killed' ? 'text-amber-400' :
                    'text-ink-400'
                  }>· {p.status}</span>
                  {p.exitCode !== null && <span className="text-ink-500">exit {p.exitCode}</span>}
                  {p.status === 'running' && (
                    <button
                      onClick={() => api.stop(p.executionId).catch(() => {})}
                      className="ml-auto text-xs text-ink-400 hover:text-red-300"
                    >停止</button>
                  )}
                </div>
                <div className="flex-1 min-h-0">
                  <TerminalView ref={(t) => { termRefs.current[p.executionId] = t; }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

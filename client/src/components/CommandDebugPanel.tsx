import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { subscribeRun } from '../lib/socket';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { VariableForm } from './VariableForm';
import { stripNoise } from '../lib/ansi';
import type { SafetyResult, TargetType, TemplateVar } from '../lib/types';

/**
 * 编辑期调试面板：用编辑器里【当前未保存的草稿】直接试跑。
 * 走 /api/run 的 inline 形式（template + interpreter），所以保存与否完全不影响——
 * 改一笔、点一下、立即看输出。
 */

interface Props {
  template: string;
  interpreter: string;
  vars: TemplateVar[];
  targetType: TargetType;
}

interface RunState {
  executionId: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode: number | null;
}

export function CommandDebugPanel({ template, interpreter, vars, targetType }: Props) {
  const connections = useStore((s) => s.connections);
  const [connectionId, setConnectionId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyResult | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);
  const termRef = useRef<TerminalHandle | null>(null);

  // 默认连接：ssh 目标优先挑 ssh 连接，否则本地
  useEffect(() => {
    if (connectionId || connections.length === 0) return;
    const prefer = targetType === 'ssh'
      ? connections.find((c) => c.type === 'ssh')
      : connections.find((c) => c.type === 'local');
    setConnectionId((prefer ?? connections[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length, targetType]);

  // 模板里新出现的变量自动带上默认值（不覆盖已手填的）
  useEffect(() => {
    setValues((cur) => {
      let changed = false;
      const next = { ...cur };
      for (const v of vars) {
        if (next[v.name] === undefined && v.defaultValue) {
          next[v.name] = v.defaultValue;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [vars]);

  async function start(confirmDanger = false) {
    setError(null);
    setSafety(null);
    setPendingConfirm(null);
    if (!template.trim()) {
      setError('命令/脚本内容为空');
      return;
    }
    if (!connectionId) {
      setError('请选择目标连接');
      return;
    }
    const missing = vars.filter((v) => v.required && !(values[v.name] ?? '').trim());
    if (missing.length > 0) {
      setError(`请填写变量：${missing.map((v) => v.name).join(', ')}`);
      return;
    }
    try {
      const res = await api.run({ template, interpreter, connectionId, values, confirmDanger });
      termRef.current?.clear();
      termRef.current?.writeln(`\x1b[90m$ ${res.execution.renderedCmd}\x1b[0m\r\n`);
      setSafety(res.safety);
      setRun({ executionId: res.execution.id, status: 'running', exitCode: null });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('dangerous command blocked')) setPendingConfirm(msg);
      else setError(msg);
    }
  }

  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const unsub = subscribeRun(run.executionId, (ev) => {
      if (ev.type === 'chunk') {
        const clean = stripNoise(ev.data);
        if (!clean) return;
        termRef.current?.write(ev.stream === 'stderr' ? `\x1b[91m${clean}\x1b[0m` : clean);
      } else if (ev.type === 'done') {
        termRef.current?.writeln(`\r\n\x1b[90m[exit ${ev.exitCode ?? '—'} · ${ev.status}]\x1b[0m`);
        setRun((cur) =>
          cur && cur.executionId === ev.executionId
            ? { ...cur, status: ev.status as RunState['status'], exitCode: ev.exitCode }
            : cur,
        );
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.executionId, run?.status]);

  const running = run?.status === 'running';

  return (
    <div className="flex flex-col h-full">
      <div className="mb-2">
        <div className="text-sm font-medium">⚒ 调试运行</div>
        <div className="text-xs text-ink-500">用当前编辑内容直接试跑，无需保存</div>
      </div>

      <label className="block mb-2">
        <span className="text-xs text-ink-300">目标连接</span>
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
          ))}
        </select>
      </label>

      {vars.length > 0 && (
        <div className="mb-2 max-h-52 overflow-auto pr-1">
          <VariableForm vars={vars} values={values} onChange={setValues} />
        </div>
      )}

      {error && (
        <div className="mb-2 text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded p-2">{error}</div>
      )}

      {pendingConfirm && (
        <div className="mb-2 bg-red-950/60 border border-red-800 rounded p-2 text-xs">
          <div className="text-red-300 font-medium mb-1">⚠ 高危命令</div>
          <div className="text-red-200 mb-2">{pendingConfirm}</div>
          <div className="flex gap-2">
            <button onClick={() => start(true)} className="flex-1 px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-white">我已确认</button>
            <button onClick={() => setPendingConfirm(null)} className="flex-1 px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded">取消</button>
          </div>
        </div>
      )}

      {safety && safety.level === 'warning' && (
        <div className="mb-2 bg-amber-950/40 border border-amber-900/60 rounded p-2 text-xs text-amber-200">
          注意：{safety.reasons.join('; ')}
        </div>
      )}

      <div className="flex items-center gap-2 mb-2">
        {running ? (
          <button
            onClick={() => run && api.stop(run.executionId).catch(() => {})}
            className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-sm font-medium"
          >■ 停止</button>
        ) : (
          <button
            onClick={() => start(false)}
            className="flex-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
          >▶ 试运行</button>
        )}
        {run && !running && (
          <span className={`text-xs ${run.status === 'completed' ? 'text-emerald-400' : 'text-red-400'}`}>
            exit {run.exitCode ?? '—'} · {run.status}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 border border-ink-800 rounded overflow-hidden">
        <TerminalView ref={termRef} />
      </div>
    </div>
  );
}

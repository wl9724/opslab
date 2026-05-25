import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { subscribePlaybook } from '../lib/socket';
import { TerminalView, type TerminalHandle } from '../components/TerminalView';
import { stripNoise } from '../lib/ansi';
import type { Playbook, PlaybookStep } from '../lib/types';

type StepState = {
  index: number;
  step: PlaybookStep;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'skipped';
  executionId?: string;
  exitCode?: number | null;
  captured?: { name: string; value: string };
  reason?: string;
};

export function PlaybookRunner() {
  const { id } = useParams();
  const commands = useStore((s) => s.commands);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [capturedVars, setCapturedVars] = useState<Record<string, string>>({});
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'completed' | 'failed' | 'aborted'>('idle');
  const [activeTerm, setActiveTerm] = useState<number>(0);
  const termRefs = useRef<Record<number, TerminalHandle | null>>({});

  useEffect(() => {
    if (!id) return;
    api.getPlaybook(id).then((p) => {
      setPlaybook(p);
      setSteps(p.steps.map((s, i) => ({ index: i, step: s, status: 'pending' as const })));
    });
  }, [id]);

  // Collect all referenced variables to allow initial value supply
  const referencedVars = useMemo(() => {
    if (!playbook) return [] as string[];
    const set = new Set<string>();
    for (const s of playbook.steps) {
      let tpl = s.inlineTemplate ?? '';
      if (s.commandId) {
        const cmd = commands.find((c) => c.id === s.commandId);
        if (cmd) tpl = cmd.template;
      }
      for (const m of tpl.matchAll(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g)) {
        set.add(m[1]);
      }
    }
    // Remove vars that will be captured by some earlier step
    for (const s of playbook.steps) if (s.captureAs) set.delete(s.captureAs);
    return [...set];
  }, [playbook, commands]);

  async function run(confirmDanger = false) {
    if (!playbook) return;
    setRunning(true);
    setOverallStatus('running');
    setCapturedVars({});
    setSteps(playbook.steps.map((s, i) => ({ index: i, step: s, status: 'pending' as const })));
    Object.values(termRefs.current).forEach((t) => t?.clear());

    try {
      const res = await api.runPlaybook({
        playbookId: playbook.id,
        initialValues,
        confirmDanger,
      });
      setRunId(res.playbookRunId);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith('dangerous command blocked')) {
        if (confirm(`⚠ ${msg}\n\n继续执行整条 Playbook？`)) {
          return run(true);
        }
      } else {
        alert(msg);
      }
      setRunning(false);
      setOverallStatus('idle');
    }
  }

  async function abort() {
    if (!runId) return;
    await api.abortPlaybook(runId).catch(() => {});
  }

  useEffect(() => {
    if (!runId) return;
    const unsub = subscribePlaybook(runId, (ev) => {
      if (ev.type === 'step-start') {
        setSteps((cur) => cur.map((s) => (s.index === ev.index ? { ...s, status: 'running', executionId: ev.executionId } : s)));
        const t = termRefs.current[ev.index];
        t?.writeln(`\x1b[90m$ ${ev.renderedCmd}\x1b[0m\r\n`);
        setActiveTerm(ev.index);
      } else if (ev.type === 'chunk') {
        const t = termRefs.current[ev.index];
        if (!t) return;
        const clean = stripNoise(ev.data);
        if (!clean) return;
        if (ev.stream === 'stderr') t.write(`\x1b[91m${clean}\x1b[0m`);
        else t.write(clean);
      } else if (ev.type === 'step-done') {
        setSteps((cur) => cur.map((s) => (s.index === ev.index ? { ...s, status: ev.status as any, exitCode: ev.exitCode, captured: ev.captured } : s)));
        const t = termRefs.current[ev.index];
        t?.writeln(`\r\n\x1b[90m[step ${ev.index + 1} exit ${ev.exitCode ?? '—'} · ${ev.status}]${ev.captured ? `  📦 captured "${ev.captured.name}"` : ''}\x1b[0m`);
        if (ev.captured) {
          setCapturedVars((cur) => ({ ...cur, [ev.captured!.name]: ev.captured!.value }));
        }
      } else if (ev.type === 'step-skipped') {
        setSteps((cur) => cur.map((s) => (s.index === ev.index ? { ...s, status: 'skipped', reason: ev.reason } : s)));
      } else if (ev.type === 'done') {
        setOverallStatus(ev.status);
        setRunning(false);
        setCapturedVars(ev.capturedVars);
      }
    });
    return unsub;
  }, [runId]);

  if (!playbook) return <div className="p-6 text-ink-500">加载中…</div>;

  const statusColor: Record<string, string> = {
    pending: 'bg-ink-800 text-ink-400',
    running: 'bg-sky-600 text-white animate-pulse',
    completed: 'bg-emerald-600 text-white',
    failed: 'bg-red-600 text-white',
    killed: 'bg-amber-600 text-white',
    skipped: 'bg-ink-700 text-ink-400',
  };

  return (
    <div className="flex h-full">
      <div className="w-96 border-r border-ink-800 overflow-auto">
        <div className="p-4 border-b border-ink-800">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="font-semibold">{playbook.name}</h2>
            <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${overallStatus === 'completed' ? 'bg-emerald-500/20 text-emerald-300' : overallStatus === 'failed' ? 'bg-red-500/20 text-red-300' : overallStatus === 'running' ? 'bg-sky-500/20 text-sky-300' : 'bg-ink-700 text-ink-400'}`}>
              {overallStatus}
            </span>
          </div>
          {playbook.description && <div className="text-xs text-ink-400 mb-3">{playbook.description}</div>}

          {referencedVars.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <div className="text-xs text-ink-300">初始变量</div>
              {referencedVars.map((name) => (
                <input
                  key={name}
                  value={initialValues[name] ?? ''}
                  onChange={(e) => setInitialValues({ ...initialValues, [name]: e.target.value })}
                  placeholder={`{{${name}}}`}
                  className="w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs font-mono"
                />
              ))}
            </div>
          )}

          {running ? (
            <button onClick={abort} className="w-full px-3 py-2 bg-red-600 hover:bg-red-500 rounded text-sm font-medium">■ 中止</button>
          ) : (
            <button onClick={() => run(false)} className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium">▶ 执行 Playbook</button>
          )}
        </div>

        <div className="p-2">
          {steps.map((s) => {
            const cmd = s.step.commandId ? commands.find((c) => c.id === s.step.commandId) : null;
            return (
              <button
                key={s.step.id}
                onClick={() => setActiveTerm(s.index)}
                className={`w-full text-left px-3 py-2 rounded mb-1 border ${activeTerm === s.index ? 'bg-ink-900 border-emerald-700' : 'bg-ink-950 border-ink-900 hover:border-ink-800'}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusColor[s.status]}`}>{s.index + 1}</span>
                  <span className="text-sm truncate flex-1">{cmd?.name ?? '(inline)'}</span>
                  {s.exitCode !== undefined && s.exitCode !== null && (
                    <span className={`text-[10px] ${s.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}`}>exit {s.exitCode}</span>
                  )}
                </div>
                {s.captured && (
                  <div className="text-[10px] text-amber-300 font-mono truncate">📦 {s.captured.name} = {s.captured.value.slice(0, 40)}{s.captured.value.length > 40 ? '…' : ''}</div>
                )}
                {s.reason && <div className="text-[10px] text-red-400">{s.reason}</div>}
              </button>
            );
          })}
        </div>

        {Object.keys(capturedVars).length > 0 && (
          <div className="p-3 border-t border-ink-800">
            <div className="text-xs text-ink-300 mb-1.5">已捕获变量</div>
            <div className="space-y-1">
              {Object.entries(capturedVars).map(([k, v]) => (
                <div key={k} className="text-[11px] font-mono">
                  <span className="text-amber-300">{`{{${k}}}`}</span>
                  <span className="text-ink-400"> = </span>
                  <span className="text-ink-200 break-all">{v.slice(0, 80)}{v.length > 80 ? '…' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 p-3 relative">
        {steps.map((s) => (
          <div key={s.index} className="absolute inset-3" style={{ display: activeTerm === s.index ? 'block' : 'none' }}>
            <TerminalView ref={(t) => { termRefs.current[s.index] = t; }} />
          </div>
        ))}
      </div>
    </div>
  );
}

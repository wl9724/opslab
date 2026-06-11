import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { subscribePlaybook } from '../lib/socket';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { stripNoise } from '../lib/ansi';
import type { Playbook, PlaybookStep } from '../lib/types';

/**
 * Playbook 编辑期调试面板：把【当前未保存的草稿】作为 inline playbook 直接运行。
 * 两种粒度：
 *   - 全部运行：整本草稿从头到尾
 *   - 单步运行：只跑某一步；自动把之前运行捕获到的变量作为 initialValues 代入，
 *     这样调试第 N 步不需要每次都重跑前 N-1 步
 */

export type DebugScope = 'all' | number;

export interface PlaybookDebugHandle {
  run: (scope: DebugScope) => void;
}

type PlaybookDraft = Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>;

interface Props {
  draft: PlaybookDraft;
}

interface StepState {
  /** Index within the inline run we submitted (events use this). */
  inlineIndex: number;
  /** Index within the editor draft (what the user sees as 步骤 N). */
  draftIndex: number;
  step: PlaybookStep;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'skipped';
  exitCode?: number | null;
  captured?: { name: string; value: string };
  reason?: string;
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-ink-800 text-ink-400',
  running: 'bg-sky-600 text-white animate-pulse',
  completed: 'bg-emerald-600 text-white',
  failed: 'bg-red-600 text-white',
  killed: 'bg-amber-600 text-white',
  skipped: 'bg-ink-700 text-ink-400',
};

export const PlaybookDebugPanel = forwardRef<PlaybookDebugHandle, Props>(({ draft }, ref) => {
  const commands = useStore((s) => s.commands);

  const [initialValues, setInitialValues] = useState<Record<string, string>>({});
  /** Captures accumulated across debug runs in this panel; fed into single-step runs. */
  const [capturedVars, setCapturedVars] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'completed' | 'failed' | 'aborted'>('idle');
  const [activeTerm, setActiveTerm] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ scope: DebugScope; msg: string } | null>(null);
  const termRefs = useRef<Record<number, TerminalHandle | null>>({});

  // 草稿里所有被引用、又不会被某步捕获的变量 → 需要用户提供初始值
  const referencedVars = useMemo(() => {
    const set = new Set<string>();
    for (const s of draft.steps) {
      let tpl = s.inlineTemplate ?? '';
      if (s.commandId) {
        const cmd = commands.find((c) => c.id === s.commandId);
        if (cmd) tpl = cmd.template;
      }
      for (const m of tpl.matchAll(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g)) set.add(m[1]);
    }
    for (const s of draft.steps) if (s.captureAs) set.delete(s.captureAs);
    return [...set];
  }, [draft.steps, commands]);

  async function runScope(scope: DebugScope, confirmDanger = false) {
    setError(null);
    setPendingConfirm(null);

    const chosen = scope === 'all' ? draft.steps : draft.steps[scope] ? [draft.steps[scope]] : [];
    if (chosen.length === 0) {
      setError('没有可执行的步骤');
      return;
    }
    const bad = chosen.findIndex((s) => !s.commandId && !(s.inlineTemplate ?? '').trim());
    if (bad >= 0) {
      const n = scope === 'all' ? bad + 1 : scope + 1;
      setError(`第 ${n} 步未选命令也没写 inline 模板`);
      return;
    }

    setOverallStatus('running');
    setActiveTerm(0);
    setSteps(chosen.map((s, i) => ({
      inlineIndex: i,
      draftIndex: scope === 'all' ? i : scope,
      step: s,
      status: 'pending' as const,
    })));
    Object.values(termRefs.current).forEach((t) => t?.clear());

    try {
      const res = await api.runPlaybook({
        inline: {
          name: draft.name || '(调试)',
          description: draft.description ?? '',
          defaultConnectionId: draft.defaultConnectionId,
          steps: chosen,
        },
        // 单步调试自动代入此前捕获的变量；手填的初始值优先
        initialValues: scope === 'all' ? initialValues : { ...capturedVars, ...initialValues },
        confirmDanger,
      });
      setRunId(res.playbookRunId);
    } catch (e) {
      setOverallStatus('idle');
      const msg = (e as Error).message;
      if (msg.startsWith('dangerous command blocked')) setPendingConfirm({ scope, msg });
      else setError(msg);
    }
  }

  useImperativeHandle(ref, () => ({ run: (scope) => void runScope(scope) }));

  async function abort() {
    if (runId) await api.abortPlaybook(runId).catch(() => {});
  }

  useEffect(() => {
    if (!runId) return;
    const unsub = subscribePlaybook(runId, (ev) => {
      if (ev.type === 'step-start') {
        setSteps((cur) => cur.map((s) => (s.inlineIndex === ev.index ? { ...s, status: 'running' } : s)));
        termRefs.current[ev.index]?.writeln(`\x1b[90m$ ${ev.renderedCmd}\x1b[0m\r\n`);
        setActiveTerm(ev.index);
      } else if (ev.type === 'chunk') {
        const t = termRefs.current[ev.index];
        if (!t) return;
        const clean = stripNoise(ev.data);
        if (!clean) return;
        t.write(ev.stream === 'stderr' ? `\x1b[91m${clean}\x1b[0m` : clean);
      } else if (ev.type === 'step-done') {
        setSteps((cur) => cur.map((s) =>
          s.inlineIndex === ev.index
            ? { ...s, status: ev.status as StepState['status'], exitCode: ev.exitCode, captured: ev.captured }
            : s,
        ));
        termRefs.current[ev.index]?.writeln(
          `\r\n\x1b[90m[exit ${ev.exitCode ?? '—'} · ${ev.status}]${ev.captured ? `  📦 captured "${ev.captured.name}"` : ''}\x1b[0m`,
        );
        if (ev.captured) {
          setCapturedVars((cur) => ({ ...cur, [ev.captured!.name]: ev.captured!.value }));
        }
      } else if (ev.type === 'step-skipped') {
        setSteps((cur) => cur.map((s) => (s.inlineIndex === ev.index ? { ...s, status: 'skipped', reason: ev.reason } : s)));
      } else if (ev.type === 'done') {
        setOverallStatus(ev.status);
      }
    });
    return unsub;
  }, [runId]);

  const running = overallStatus === 'running';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-2">
        <div>
          <div className="text-sm font-medium">⚒ 调试运行</div>
          <div className="text-xs text-ink-500">直接运行当前草稿，无需保存</div>
        </div>
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${
          overallStatus === 'completed' ? 'bg-emerald-500/20 text-emerald-300' :
          overallStatus === 'failed' ? 'bg-red-500/20 text-red-300' :
          overallStatus === 'aborted' ? 'bg-amber-500/20 text-amber-300' :
          overallStatus === 'running' ? 'bg-sky-500/20 text-sky-300' :
          'bg-ink-700 text-ink-400'
        }`}>{overallStatus}</span>
        {running ? (
          <button onClick={abort} className="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded text-sm font-medium">■ 中止</button>
        ) : (
          <button onClick={() => runScope('all')} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium">▶ 全部运行</button>
        )}
      </div>

      {referencedVars.length > 0 && (
        <div className="mb-2">
          <div className="text-xs text-ink-300 mb-1">初始变量</div>
          <div className="grid grid-cols-2 gap-1.5 max-h-24 overflow-auto pr-1">
            {referencedVars.map((name) => (
              <input
                key={name}
                value={initialValues[name] ?? ''}
                onChange={(e) => setInitialValues({ ...initialValues, [name]: e.target.value })}
                placeholder={`{{${name}}}`}
                className="bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs font-mono"
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-2 text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded p-2">{error}</div>
      )}

      {pendingConfirm && (
        <div className="mb-2 bg-red-950/60 border border-red-800 rounded p-2 text-xs">
          <div className="text-red-300 font-medium mb-1">⚠ 高危命令</div>
          <div className="text-red-200 mb-2">{pendingConfirm.msg}</div>
          <div className="flex gap-2">
            <button
              onClick={() => runScope(pendingConfirm.scope, true)}
              className="flex-1 px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-white"
            >我已确认</button>
            <button onClick={() => setPendingConfirm(null)} className="flex-1 px-2 py-1 bg-ink-800 hover:bg-ink-700 rounded">取消</button>
          </div>
        </div>
      )}

      {steps.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {steps.map((s) => {
            const cmd = s.step.commandId ? commands.find((c) => c.id === s.step.commandId) : null;
            return (
              <button
                key={s.inlineIndex}
                onClick={() => setActiveTerm(s.inlineIndex)}
                title={cmd?.name ?? s.step.inlineTemplate ?? ''}
                className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${
                  activeTerm === s.inlineIndex ? 'bg-ink-900 border-emerald-700' : 'bg-ink-950 border-ink-800 hover:border-ink-700'
                }`}
              >
                <span className={`text-[10px] px-1 rounded ${STATUS_COLOR[s.status]}`}>{s.draftIndex + 1}</span>
                <span className="max-w-28 truncate">{cmd?.name ?? '(inline)'}</span>
                {s.exitCode !== undefined && s.exitCode !== null && (
                  <span className={s.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>exit {s.exitCode}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {Object.keys(capturedVars).length > 0 && (
        <div className="mb-2 max-h-20 overflow-auto">
          <div className="text-xs text-ink-300 mb-0.5">已捕获变量 <span className="text-ink-500">（单步运行会自动代入）</span></div>
          {Object.entries(capturedVars).map(([k, v]) => (
            <div key={k} className="text-[11px] font-mono">
              <span className="text-amber-300">{`{{${k}}}`}</span>
              <span className="text-ink-400"> = </span>
              <span className="text-ink-200 break-all">{v.slice(0, 60)}{v.length > 60 ? '…' : ''}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0 relative border border-ink-800 rounded overflow-hidden">
        {steps.length === 0 ? (
          <div className="h-full flex items-center justify-center text-ink-500 text-xs px-4 text-center">
            点 ▶ 全部运行，或在左侧任一步骤上点 ▶ 单步
          </div>
        ) : (
          steps.map((s) => (
            <div
              key={s.inlineIndex}
              className="absolute inset-0"
              style={{ display: activeTerm === s.inlineIndex ? 'block' : 'none' }}
            >
              <TerminalView ref={(t) => { termRefs.current[s.inlineIndex] = t; }} />
            </div>
          ))
        )}
      </div>
    </div>
  );
});

PlaybookDebugPanel.displayName = 'PlaybookDebugPanel';

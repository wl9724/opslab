import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { stripNoise } from '../lib/ansi';
import type { Execution } from '../lib/types';

const STATUS_COLOR: Record<string, string> = {
  running: 'text-sky-300',
  completed: 'text-emerald-300',
  failed: 'text-red-300',
  killed: 'text-amber-300',
};

export function History() {
  const [list, setList] = useState<Execution[]>([]);
  const [selected, setSelected] = useState<(Execution & { output: string }) | null>(null);

  useEffect(() => {
    api.listExecutions(100).then(setList);
  }, []);

  async function pick(e: Execution) {
    const full = await api.getExecution(e.id);
    setSelected(full);
  }

  const cleanedOutput = useMemo(
    () => (selected ? stripNoise(selected.output).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') : ''),
    [selected],
  );

  return (
    <div className="flex h-full">
      <div className="w-96 border-r border-ink-800 overflow-auto">
        <div className="p-4 border-b border-ink-800">
          <h1 className="text-lg font-semibold">执行历史</h1>
          <div className="text-xs text-ink-500">{list.length} 条</div>
        </div>
        {list.map((e) => (
          <button
            key={e.id}
            onClick={() => pick(e)}
            className={`block w-full text-left px-4 py-3 border-b border-ink-900 hover:bg-ink-900 ${selected?.id === e.id ? 'bg-ink-900' : ''}`}
          >
            <div className="flex items-center gap-2 text-xs mb-1">
              <span className={STATUS_COLOR[e.status] ?? ''}>{e.status}</span>
              <span className="text-ink-500">exit {e.exitCode ?? '—'}</span>
              <span className="text-ink-500 ml-auto">{new Date(e.startedAt).toLocaleString()}</span>
            </div>
            <div className="text-xs font-mono text-ink-300 truncate">{e.renderedCmd}</div>
          </button>
        ))}
      </div>
      <div className="flex-1 p-4 overflow-auto">
        {selected ? (
          <>
            <div className="mb-3">
              <div className="text-xs text-ink-400">{new Date(selected.startedAt).toLocaleString()}</div>
              <pre className="mt-1 bg-ink-900 border border-ink-800 rounded p-2 text-sm font-mono text-emerald-200 whitespace-pre-wrap break-words">
                {selected.renderedCmd}
              </pre>
            </div>
            <pre className="bg-[#0b1220] border border-ink-800 rounded p-3 text-xs font-mono text-ink-200 whitespace-pre-wrap break-words max-h-[70vh] overflow-auto">
              {cleanedOutput || '(无输出)'}
            </pre>
          </>
        ) : (
          <div className="text-ink-500 text-sm">选择左侧一条记录查看输出</div>
        )}
      </div>
    </div>
  );
}

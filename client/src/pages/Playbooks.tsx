import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import type { Playbook } from '../lib/types';

export function Playbooks() {
  const playbooks = useStore((s) => s.playbooks);
  const reload = useStore((s) => s.reloadPlaybooks);
  const navigate = useNavigate();

  async function remove(p: Playbook) {
    if (!confirm(`删除 Playbook "${p.name}"？`)) return;
    await api.deletePlaybook(p.id);
    await reload();
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold">Playbooks</h1>
        <span className="text-sm text-ink-500">{playbooks.length} 个</span>
        <span className="text-xs text-ink-500 ml-2">将多个命令模板串成一个一键执行的剧本</span>
        <Link
          to="/playbooks/new"
          className="ml-auto px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
        >+ 新建 Playbook</Link>
      </div>

      {playbooks.length === 0 ? (
        <div className="text-center py-20 text-ink-500">
          <div className="text-4xl mb-2">⛓</div>
          <div className="text-sm">还没有 Playbook，新建一个串联多步骤</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {playbooks.map((p) => (
            <div key={p.id} className="bg-ink-900 border border-ink-800 rounded p-4 flex flex-col">
              <div className="font-medium truncate">{p.name}</div>
              {p.description && <div className="text-xs text-ink-400 mt-1 line-clamp-2">{p.description}</div>}
              <div className="text-xs text-ink-500 mt-2">{p.steps.length} 步</div>
              <div className="mt-3 space-y-1">
                {p.steps.slice(0, 4).map((s, i) => (
                  <div key={s.id} className="text-xs text-ink-300 truncate">
                    <span className="text-ink-600 mr-1">{i + 1}.</span>
                    {s.commandId ? <span className="text-emerald-300">→ command</span> : <span className="text-purple-300">→ inline</span>}
                    {s.captureAs && <span className="ml-1 text-amber-300">→ {`{{${s.captureAs}}}`}</span>}
                  </div>
                ))}
                {p.steps.length > 4 && <div className="text-xs text-ink-600">…还有 {p.steps.length - 4} 步</div>}
              </div>
              <div className="mt-auto pt-3 flex gap-2">
                <button
                  onClick={() => navigate(`/playbooks/${p.id}/run`)}
                  className="flex-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
                >▶ 执行</button>
                <button
                  onClick={() => navigate(`/playbooks/${p.id}`)}
                  className="px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm"
                >编辑</button>
                <button
                  onClick={() => remove(p)}
                  className="px-2 py-1.5 bg-ink-800 hover:bg-red-900 rounded text-sm text-ink-400"
                >✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

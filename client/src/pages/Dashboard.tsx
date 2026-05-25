import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import type { CommandTemplate, TargetType } from '../lib/types';

const TARGET_BADGE: Record<TargetType, string> = {
  local: 'bg-sky-500/20 text-sky-300',
  ssh: 'bg-purple-500/20 text-purple-300',
  docker: 'bg-blue-500/20 text-blue-300',
  k8s: 'bg-indigo-500/20 text-indigo-300',
};

export function Dashboard() {
  const commands = useStore((s) => s.commands);
  const reload = useStore((s) => s.reloadCommands);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.template.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [commands, query]);

  async function toggleFav(c: CommandTemplate) {
    await api.updateCommand(c.id, { favorite: !c.favorite });
    reload();
  }

  async function remove(c: CommandTemplate) {
    if (!confirm(`删除命令 "${c.name}" ？`)) return;
    await api.deleteCommand(c.id);
    reload();
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold">命令</h1>
        <span className="text-sm text-ink-500">{commands.length} 条</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称/描述/标签…"
          className="ml-4 bg-ink-900 border border-ink-700 rounded px-3 py-1.5 text-sm w-72 focus:outline-none focus:border-emerald-500"
        />
        <Link
          to="/commands/new"
          className="ml-auto px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
        >+ 新建命令</Link>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-ink-500">
          <div className="text-4xl mb-2">⌘</div>
          <div className="text-sm">{commands.length === 0 ? '还没有命令，点右上角新建一个' : '没有匹配的命令'}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <div
              key={c.id}
              className="bg-ink-900 border border-ink-800 rounded p-4 hover:border-ink-700 transition-colors flex flex-col"
            >
              <div className="flex items-start gap-2 mb-1">
                <button
                  onClick={() => toggleFav(c)}
                  className={`text-base leading-none ${c.favorite ? 'text-amber-400' : 'text-ink-600 hover:text-ink-400'}`}
                  title={c.favorite ? '取消收藏' : '收藏'}
                >★</button>
                <div className="flex-1 font-medium truncate">{c.name}</div>
                {c.interpreter && c.interpreter !== 'auto' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300" title={`脚本：${c.interpreter}`}>
                    📜 {c.interpreter}
                  </span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${TARGET_BADGE[c.targetType]}`}>{c.targetType}</span>
              </div>
              {c.description && (
                <div className="text-xs text-ink-400 mb-2 line-clamp-2">{c.description}</div>
              )}
              <pre className="bg-ink-950 border border-ink-800 rounded p-2 text-xs font-mono text-emerald-200 overflow-hidden mb-3 line-clamp-3 whitespace-pre-wrap break-words">
                {c.template}
              </pre>
              {c.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {c.tags.map((t) => (
                    <span key={t} className="text-[10px] bg-ink-800 px-1.5 py-0.5 rounded text-ink-300">#{t}</span>
                  ))}
                </div>
              )}
              <div className="mt-auto flex gap-2">
                <button
                  onClick={() => navigate(`/run/${c.id}`)}
                  className="flex-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
                >▶ 执行</button>
                <button
                  onClick={() => navigate(`/commands/${c.id}`)}
                  className="px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm"
                >编辑</button>
                <button
                  onClick={() => remove(c)}
                  className="px-2 py-1.5 bg-ink-800 hover:bg-red-900 rounded text-sm text-ink-400"
                  title="删除"
                >✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

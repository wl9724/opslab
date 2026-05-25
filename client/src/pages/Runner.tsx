import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { RunnerSession } from '../components/RunnerSession';

interface Tab {
  id: string;
  title: string;
  initialCommandId?: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
}

function tabId() {
  return Math.random().toString(36).slice(2, 8);
}

export function Runner() {
  const { commandId } = useParams();
  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: tabId(), title: '新会话', initialCommandId: commandId, status: 'idle' },
  ]);
  const [activeId, setActiveId] = useState(tabs[0].id);

  // If commandId changes (navigation from dashboard while runner is mounted), open in new tab
  useEffect(() => {
    if (!commandId) return;
    setTabs((cur) => {
      // Avoid duplicating if active tab is empty
      const active = cur.find((t) => t.id === activeId);
      if (active && !active.initialCommandId) {
        return cur.map((t) => (t.id === activeId ? { ...t, initialCommandId: commandId } : t));
      }
      const newTab: Tab = { id: tabId(), title: '新会话', initialCommandId: commandId, status: 'idle' };
      setActiveId(newTab.id);
      return [...cur, newTab];
    });
  }, [commandId]);

  function addTab() {
    const t: Tab = { id: tabId(), title: '新会话', status: 'idle' };
    setTabs((cur) => [...cur, t]);
    setActiveId(t.id);
  }

  function closeTab(id: string) {
    setTabs((cur) => {
      const next = cur.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = { id: tabId(), title: '新会话', status: 'idle' as const };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(next[next.length - 1].id);
      return next;
    });
  }

  function updateTab(id: string, patch: Partial<Tab>) {
    setTabs((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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
              {t.status === 'running' && <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-pulse" />}
              {t.status === 'completed' && <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />}
              {t.status === 'failed' && <span className="w-1.5 h-1.5 bg-red-400 rounded-full" />}
              <span className="max-w-[160px] truncate">{t.title}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  className="text-ink-600 hover:text-ink-200"
                >×</button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={addTab}
          className="px-3 py-1 ml-2 text-ink-400 hover:text-emerald-300 text-lg leading-none"
          title="新建标签页"
        >+</button>
      </div>

      <div className="flex-1 min-h-0 relative">
        {tabs.map((t) => (
          <div key={t.id} className="absolute inset-0" style={{ display: activeId === t.id ? 'block' : 'none' }}>
            <RunnerSession
              initialCommandId={t.initialCommandId}
              onTitleChange={(title) => updateTab(t.id, { title })}
              onStatusChange={(status) => updateTab(t.id, { status })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

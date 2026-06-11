import { useEffect } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { CommandEditor } from './pages/CommandEditor';
import { Runner } from './pages/Runner';
import { WebTerminal } from './pages/WebTerminal';
import { Connections } from './pages/Connections';
import { History } from './pages/History';
import { Settings } from './pages/Settings';
import { Playbooks } from './pages/Playbooks';
import { PlaybookEditor } from './pages/PlaybookEditor';
import { PlaybookRunner } from './pages/PlaybookRunner';
import { Debug } from './pages/Debug';
import { useStore } from './lib/store';

const NAV = [
  { to: '/', label: '命令', icon: '⌘' },
  { to: '/run', label: '终端', icon: '▶' },
  { to: '/terminal', label: 'Shell', icon: '⌨' },
  { to: '/playbooks', label: 'Playbook', icon: '⛓' },
  { to: '/connections', label: '连接', icon: '⇄' },
  { to: '/history', label: '历史', icon: '⌛' },
  { to: '/settings', label: 'AI 设置', icon: '✦' },
  { to: '/debug', label: '调试', icon: '⌬' },
];

export function App() {
  const loadAll = useStore((s) => s.loadAll);
  const error = useStore((s) => s.error);
  const os = useStore((s) => s.os);
  const location = useLocation();

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return (
    <div className="flex h-full">
      <aside className="w-52 bg-ink-950 border-r border-ink-800 flex flex-col">
        <div className="px-5 py-4 border-b border-ink-800">
          <div className="text-xl font-semibold text-emerald-400">OpsLab</div>
          <div className="text-xs text-ink-500 mt-0.5">{os || 'detecting…'}</div>
        </div>
        <nav className="flex-1 py-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-400'
                    : 'text-ink-300 hover:bg-ink-800/50 border-l-2 border-transparent'
                }`
              }
            >
              <span className="text-base w-4">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-3 text-xs text-ink-500 border-t border-ink-800">
          v0.1.1
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        {error && (
          <div className="bg-red-900/30 border-b border-red-900 px-5 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
        <div key={location.pathname} className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/commands/new" element={<CommandEditor />} />
            <Route path="/commands/:id" element={<CommandEditor />} />
            <Route path="/run/:commandId" element={<Runner />} />
            <Route path="/run" element={<Runner />} />
            <Route path="/terminal" element={<WebTerminal />} />
            <Route path="/playbooks" element={<Playbooks />} />
            <Route path="/playbooks/new" element={<PlaybookEditor />} />
            <Route path="/playbooks/:id" element={<PlaybookEditor />} />
            <Route path="/playbooks/:id/run" element={<PlaybookRunner />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/debug" element={<Debug />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

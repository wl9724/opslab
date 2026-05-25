import { useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import type { Connection, SSHAuthType } from '../lib/types';

interface FormState {
  id?: string;
  name: string;
  type: 'local' | 'ssh';
  host: string;
  port: string;
  username: string;
  authType: SSHAuthType;
  secret: string;
}

function blank(): FormState {
  return { name: '', type: 'ssh', host: '', port: '22', username: '', authType: 'password', secret: '' };
}

export function Connections() {
  const connections = useStore((s) => s.connections);
  const reload = useStore((s) => s.reloadConnections);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  function edit(c: Connection) {
    setEditing({
      id: c.id,
      name: c.name,
      type: c.type,
      host: c.host ?? '',
      port: String(c.port ?? 22),
      username: c.username ?? '',
      authType: c.authType ?? 'password',
      secret: '',
    });
  }

  async function save() {
    if (!editing) return;
    const payload: any = {
      name: editing.name,
      type: editing.type,
      host: editing.host || undefined,
      port: editing.port ? Number(editing.port) : undefined,
      username: editing.username || undefined,
      authType: editing.type === 'ssh' ? editing.authType : undefined,
    };
    if (editing.secret) payload.secret = editing.secret;
    if (editing.id) await api.updateConnection(editing.id, payload);
    else await api.createConnection(payload);
    await reload();
    setEditing(null);
  }

  async function remove(c: Connection) {
    if (c.type === 'local') return;
    if (!confirm(`删除连接 "${c.name}"？`)) return;
    await api.deleteConnection(c.id);
    await reload();
  }

  async function test(c: Connection) {
    setTesting(c.id);
    try {
      const r = await api.testConnection(c.id);
      setTestResult({ ...testResult, [c.id]: (r.ok ? '✓ ' : '✗ ') + r.message });
    } catch (e) {
      setTestResult({ ...testResult, [c.id]: '✗ ' + (e as Error).message });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold">连接</h1>
        <span className="text-sm text-ink-500">{connections.length} 个</span>
        <button
          onClick={() => setEditing(blank())}
          className="ml-auto px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
        >+ 新建 SSH 连接</button>
      </div>

      <div className="space-y-2 max-w-3xl">
        {connections.map((c) => (
          <div key={c.id} className="bg-ink-900 border border-ink-800 rounded p-3 flex items-center gap-3">
            <div className="text-xs px-2 py-0.5 rounded bg-ink-800 text-ink-300">{c.type}</div>
            <div className="flex-1">
              <div className="font-medium">{c.name}</div>
              <div className="text-xs text-ink-400 font-mono">
                {c.type === 'ssh' ? `${c.username ?? ''}@${c.host ?? ''}:${c.port ?? 22}` : 'localhost'}
              </div>
            </div>
            {testResult[c.id] && (
              <div className={`text-xs ${testResult[c.id].startsWith('✓') ? 'text-emerald-400' : 'text-red-400'}`}>
                {testResult[c.id]}
              </div>
            )}
            {c.type === 'ssh' && (
              <button
                onClick={() => test(c)}
                disabled={testing === c.id}
                className="px-2 py-1 text-xs bg-ink-800 hover:bg-ink-700 rounded"
              >{testing === c.id ? '…' : '测试'}</button>
            )}
            <button
              onClick={() => edit(c)}
              className="px-2 py-1 text-xs bg-ink-800 hover:bg-ink-700 rounded"
              disabled={c.type === 'local'}
            >编辑</button>
            <button
              onClick={() => remove(c)}
              className="px-2 py-1 text-xs bg-ink-800 hover:bg-red-900 rounded text-ink-400 disabled:opacity-30"
              disabled={c.type === 'local'}
            >删除</button>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-ink-900 border border-ink-700 rounded-lg p-5 w-[480px] max-w-[90vw]">
            <div className="text-lg font-semibold mb-4">{editing.id ? '编辑连接' : '新建 SSH 连接'}</div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-ink-300">名称</span>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                />
              </label>
              <div className="grid grid-cols-3 gap-3">
                <label className="block col-span-2">
                  <span className="text-xs text-ink-300">Host</span>
                  <input
                    value={editing.host}
                    onChange={(e) => setEditing({ ...editing, host: e.target.value })}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-ink-300">Port</span>
                  <input
                    value={editing.port}
                    onChange={(e) => setEditing({ ...editing, port: e.target.value })}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs text-ink-300">用户名</span>
                <input
                  value={editing.username}
                  onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                  className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-300">认证方式</span>
                <select
                  value={editing.authType}
                  onChange={(e) => setEditing({ ...editing, authType: e.target.value as SSHAuthType })}
                  className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                >
                  <option value="password">密码</option>
                  <option value="privateKey">私钥</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-ink-300">
                  {editing.authType === 'privateKey' ? '私钥内容' : '密码'}
                  {editing.id && <span className="ml-2 text-ink-500">(留空则不修改)</span>}
                </span>
                {editing.authType === 'privateKey' ? (
                  <textarea
                    value={editing.secret}
                    onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                    rows={4}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-xs font-mono"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…"
                  />
                ) : (
                  <input
                    type="password"
                    value={editing.secret}
                    onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                  />
                )}
              </label>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm">取消</button>
              <button onClick={save} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

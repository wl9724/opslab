import { useRef, useState, type ChangeEvent } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import type { AIProvider, AIProviderType } from '../lib/types';

interface FormState {
  id?: string;
  name: string;
  type: AIProviderType;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  isDefault: boolean;
}

const PRESETS: Record<AIProviderType, { baseUrl: string; model: string; hint: string }> = {
  claude: { baseUrl: '', model: 'claude-sonnet-4-6', hint: '使用官方 Anthropic API，留空 baseUrl 即可' },
  openai: { baseUrl: '', model: 'gpt-4o-mini', hint: '可填 OpenAI 兼容端点的 baseUrl（如 DeepSeek、通义千问、本地代理等）' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1', hint: '本地 Ollama，无需 API key' },
};

function blank(type: AIProviderType = 'claude'): FormState {
  const p = PRESETS[type];
  return { name: '', type, baseUrl: p.baseUrl, model: p.model, apiKey: '', enabled: true, isDefault: false };
}

export function Settings() {
  const providers = useStore((s) => s.providers);
  const reload = useStore((s) => s.reloadProviders);
  const loadAll = useStore((s) => s.loadAll);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function edit(p: AIProvider) {
    setEditing({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl ?? '',
      model: p.model,
      apiKey: '',
      enabled: p.enabled,
      isDefault: p.isDefault,
    });
  }

  async function save() {
    if (!editing) return;
    const payload: any = {
      name: editing.name,
      type: editing.type,
      baseUrl: editing.baseUrl || undefined,
      model: editing.model,
      enabled: editing.enabled,
      isDefault: editing.isDefault,
    };
    if (editing.apiKey) payload.apiKey = editing.apiKey;
    if (editing.id) await api.updateProvider(editing.id, payload);
    else await api.createProvider(payload);
    await reload();
    setEditing(null);
  }

  async function remove(p: AIProvider) {
    if (!confirm(`删除 "${p.name}"？`)) return;
    await api.deleteProvider(p.id);
    await reload();
  }

  async function setDefault(p: AIProvider) {
    await api.updateProvider(p.id, { isDefault: true });
    await reload();
  }

  async function exportBackup() {
    setBusy(true);
    setBackupMsg(null);
    try {
      const file = await api.exportBackup(includeSecrets);
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `opslab-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupMsg('✓ 已导出备份文件');
    } catch (e) {
      setBackupMsg('✗ 导出失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (
      importMode === 'replace' &&
      !confirm('覆盖导入会先清空当前所有命令、连接、Playbook、AI Provider，再从文件还原。确定继续？')
    )
      return;
    setBusy(true);
    setBackupMsg(null);
    try {
      const data = JSON.parse(await f.text());
      const sum = await api.importBackup(data, importMode);
      await loadAll();
      const i = sum.imported;
      setBackupMsg(
        `✓ 导入完成（${sum.mode === 'replace' ? '覆盖' : '合并'}）：命令 ${i.commands} · 连接 ${i.connections} · Playbook ${i.playbooks} · Provider ${i.providers}` +
          (sum.secretsRestored ? ` · 恢复密钥 ${sum.secretsRestored}` : '') +
          (sum.skipped ? ` · 跳过 ${sum.skipped}` : ''),
      );
    } catch (e) {
      setBackupMsg('✗ 导入失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-6">设置</h1>

      <div className="flex items-center gap-3 mb-3 max-w-3xl">
        <h2 className="text-lg font-semibold">AI Provider</h2>
        <span className="text-sm text-ink-500">{providers.length} 个</span>
        <button
          onClick={() => setEditing(blank())}
          className="ml-auto px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
        >+ 添加 Provider</button>
      </div>

      {providers.length === 0 && (
        <div className="text-center py-16 text-ink-500 text-sm">
          还没配置 AI Provider。点右上角添加一个 Claude / OpenAI / Ollama。
        </div>
      )}

      <div className="space-y-2 max-w-3xl">
        {providers.map((p) => (
          <div key={p.id} className="bg-ink-900 border border-ink-800 rounded p-3 flex items-center gap-3">
            <div className="text-xs px-2 py-0.5 rounded bg-ink-800 text-ink-300 uppercase">{p.type}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {p.isDefault && <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">默认</span>}
                {!p.enabled && <span className="text-[10px] bg-ink-700 text-ink-400 px-1.5 py-0.5 rounded">已停用</span>}
                {p.type !== 'ollama' && !p.hasKey && <span className="text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded">未设密钥</span>}
              </div>
              <div className="text-xs text-ink-400 font-mono">{p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</div>
            </div>
            {!p.isDefault && (
              <button onClick={() => setDefault(p)} className="px-2 py-1 text-xs bg-ink-800 hover:bg-ink-700 rounded">设为默认</button>
            )}
            <button onClick={() => edit(p)} className="px-2 py-1 text-xs bg-ink-800 hover:bg-ink-700 rounded">编辑</button>
            <button onClick={() => remove(p)} className="px-2 py-1 text-xs bg-ink-800 hover:bg-red-900 rounded text-ink-400">删除</button>
          </div>
        ))}
      </div>

      {/* ---- one-click backup / restore ---- */}
      <div className="max-w-3xl mt-12">
        <h2 className="text-lg font-semibold mb-1">数据备份 / 迁移</h2>
        <p className="text-xs text-ink-500 mb-3">
          把命令、连接、Playbook、AI Provider 一键导出为单个 JSON 文件，可在另一台机器导入还原。执行历史不包含在内。
        </p>
        <div className="bg-ink-900 border border-ink-800 rounded p-4 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={exportBackup}
              disabled={busy}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium disabled:opacity-50"
            >⬇ 导出备份</button>
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={includeSecrets}
                onChange={(e) => setIncludeSecrets(e.target.checked)}
                className="accent-emerald-500"
              />
              包含密钥（SSH 密码 / API Key）
            </label>
            {includeSecrets && (
              <span className="text-[11px] text-amber-400">⚠ 文件将含明文凭据，请妥善保管</span>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap border-t border-ink-800 pt-4">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm disabled:opacity-50"
            >⬆ 选择文件导入…</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              onChange={importBackup}
              className="hidden"
            />
            <label className="flex items-center gap-2 text-sm text-ink-300">
              模式
              <select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
                className="bg-ink-950 border border-ink-700 rounded px-2 py-1 text-sm"
              >
                <option value="merge">合并（保留现有，按 ID 覆盖同项）</option>
                <option value="replace">覆盖（清空后还原）</option>
              </select>
            </label>
          </div>

          {backupMsg && (
            <div className="text-xs text-ink-200 bg-ink-950 border border-ink-800 rounded px-3 py-2 break-all">
              {backupMsg}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-ink-900 border border-ink-700 rounded-lg p-5 w-[520px] max-w-[90vw]">
            <div className="text-lg font-semibold mb-4">{editing.id ? '编辑 Provider' : '添加 Provider'}</div>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <label className="block col-span-1">
                  <span className="text-xs text-ink-300">类型</span>
                  <select
                    value={editing.type}
                    onChange={(e) => {
                      const t = e.target.value as AIProviderType;
                      const p = PRESETS[t];
                      setEditing({ ...editing, type: t, baseUrl: editing.baseUrl || p.baseUrl, model: editing.model || p.model });
                    }}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                  >
                    <option value="claude">Claude</option>
                    <option value="openai">OpenAI 兼容</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </label>
                <label className="block col-span-2">
                  <span className="text-xs text-ink-300">名称</span>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="My Claude"
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs text-ink-300">模型</span>
                <input
                  value={editing.model}
                  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm font-mono"
                />
              </label>
              <label className="block">
                <span className="text-xs text-ink-300">Base URL</span>
                <input
                  value={editing.baseUrl}
                  onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                  placeholder={editing.type === 'claude' ? '(留空走官方 API)' : ''}
                  className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm font-mono"
                />
                <div className="text-[11px] text-ink-500 mt-1">{PRESETS[editing.type].hint}</div>
              </label>
              {editing.type !== 'ollama' && (
                <label className="block">
                  <span className="text-xs text-ink-300">
                    API Key {editing.id && <span className="ml-2 text-ink-500">(留空则不修改)</span>}
                  </span>
                  <input
                    type="password"
                    value={editing.apiKey}
                    onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                    className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1.5 text-sm font-mono"
                  />
                </label>
              )}
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.enabled}
                    onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                    className="accent-emerald-500"
                  /> 启用
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.isDefault}
                    onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })}
                    className="accent-emerald-500"
                  /> 设为默认
                </label>
              </div>
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

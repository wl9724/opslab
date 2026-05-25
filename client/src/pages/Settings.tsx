import { useState } from 'react';
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
  const [editing, setEditing] = useState<FormState | null>(null);

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

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold">AI 设置</h1>
        <span className="text-sm text-ink-500">{providers.length} 个 provider</span>
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

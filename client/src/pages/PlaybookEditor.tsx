import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { Playbook, PlaybookStep } from '../lib/types';

function emptyPlaybook(): Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'> {
  return { name: '', description: '', defaultConnectionId: undefined, steps: [] };
}

function newStep(): PlaybookStep {
  return {
    id: Math.random().toString(36).slice(2, 10),
    commandId: null,
    inlineTemplate: '',
    connectionId: undefined,
    values: {},
    continueOnError: false,
    captureAs: undefined,
  };
}

export function PlaybookEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const commands = useStore((s) => s.commands);
  const connections = useStore((s) => s.connections);
  const reload = useStore((s) => s.reloadPlaybooks);

  const [form, setForm] = useState(emptyPlaybook());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.getPlaybook(id).then((p) => {
      const { id: _i, createdAt: _ca, updatedAt: _ua, ...rest } = p;
      setForm(rest);
    });
  }, [id]);

  function setStep(idx: number, patch: Partial<PlaybookStep>) {
    setForm((cur) => {
      const steps = cur.steps.slice();
      steps[idx] = { ...steps[idx], ...patch };
      return { ...cur, steps };
    });
  }

  function move(idx: number, dir: -1 | 1) {
    setForm((cur) => {
      const steps = cur.steps.slice();
      const target = idx + dir;
      if (target < 0 || target >= steps.length) return cur;
      [steps[idx], steps[target]] = [steps[target], steps[idx]];
      return { ...cur, steps };
    });
  }

  function addStep() {
    setForm((cur) => ({ ...cur, steps: [...cur.steps, newStep()] }));
  }

  function removeStep(idx: number) {
    setForm((cur) => ({ ...cur, steps: cur.steps.filter((_, i) => i !== idx) }));
  }

  async function save() {
    if (!form.name.trim()) {
      alert('名称必填');
      return;
    }
    if (form.steps.length === 0) {
      alert('至少需要一个步骤');
      return;
    }
    setLoading(true);
    try {
      if (id) await api.updatePlaybook(id, form);
      else await api.createPlaybook(form);
      await reload();
      navigate('/playbooks');
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-semibold">{id ? '编辑 Playbook' : '新建 Playbook'}</h1>
        <button
          onClick={() => navigate('/playbooks')}
          className="ml-auto px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm"
        >取消</button>
        <button
          onClick={save}
          disabled={loading}
          className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded text-sm font-medium"
        >{loading ? '保存中…' : '保存'}</button>
      </div>

      <div className="max-w-4xl space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-ink-300">名称 *</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-300">默认连接</span>
            <select
              value={form.defaultConnectionId ?? ''}
              onChange={(e) => setForm({ ...form, defaultConnectionId: e.target.value || undefined })}
              className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
            >
              <option value="">(本地)</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-ink-300">描述</span>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
          />
        </label>

        <div className="flex items-center gap-2 mt-6">
          <h2 className="font-semibold">步骤</h2>
          <span className="text-xs text-ink-500">{form.steps.length} 步</span>
          <button
            onClick={addStep}
            className="ml-auto px-3 py-1 bg-ink-800 hover:bg-ink-700 rounded text-xs"
          >+ 添加步骤</button>
        </div>

        <div className="space-y-2">
          {form.steps.map((s, i) => {
            const cmd = s.commandId ? commands.find((c) => c.id === s.commandId) : null;
            return (
              <div key={s.id} className="bg-ink-900 border border-ink-800 rounded p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded">{i + 1}</span>
                  <div className="flex-1 text-sm">{cmd?.name ?? '(inline)'}</div>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-xs text-ink-400 hover:text-ink-200 disabled:opacity-30">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === form.steps.length - 1} className="text-xs text-ink-400 hover:text-ink-200 disabled:opacity-30">↓</button>
                  <button onClick={() => removeStep(i)} className="text-xs text-ink-400 hover:text-red-400">✕</button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-ink-400">命令</span>
                    <select
                      value={s.commandId ?? '__inline__'}
                      onChange={(e) => setStep(i, { commandId: e.target.value === '__inline__' ? null : e.target.value })}
                      className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                    >
                      <option value="__inline__">— inline 临时命令 —</option>
                      {commands.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-400">连接覆盖</span>
                    <select
                      value={s.connectionId ?? ''}
                      onChange={(e) => setStep(i, { connectionId: e.target.value || undefined })}
                      className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                    >
                      <option value="">(用 Playbook 默认)</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                </div>

                {!s.commandId && (
                  <label className="block mt-2">
                    <span className="text-xs text-ink-400">inline 模板</span>
                    <textarea
                      value={s.inlineTemplate ?? ''}
                      onChange={(e) => setStep(i, { inlineTemplate: e.target.value })}
                      rows={2}
                      className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs font-mono"
                      placeholder="echo {{message}}"
                    />
                  </label>
                )}

                {cmd && cmd.vars.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs text-ink-400 mb-1">变量覆盖（留空走默认或上一步捕获）</div>
                    <div className="grid grid-cols-2 gap-2">
                      {cmd.vars.map((v) => (
                        <label key={v.name} className="block">
                          <span className="text-[10px] font-mono text-emerald-300">{`{{${v.name}}}`}</span>
                          <input
                            value={s.values?.[v.name] ?? ''}
                            onChange={(e) => setStep(i, { values: { ...(s.values ?? {}), [v.name]: e.target.value } })}
                            placeholder={v.defaultValue ?? v.label}
                            className="mt-0.5 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs font-mono"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-2 grid grid-cols-2 gap-3 items-center">
                  <label className="flex items-center gap-1.5 text-xs text-ink-300">
                    <input
                      type="checkbox"
                      checked={s.continueOnError}
                      onChange={(e) => setStep(i, { continueOnError: e.target.checked })}
                      className="accent-emerald-500"
                    /> 失败时仍继续
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-400">把输出捕获为变量（供后续步骤 <code className="bg-ink-800 px-1 rounded">{`{{x}}`}</code> 引用）</span>
                    <input
                      value={s.captureAs ?? ''}
                      onChange={(e) => setStep(i, { captureAs: e.target.value || undefined })}
                      placeholder="变量名，留空不捕获"
                      className="mt-1 w-full bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs font-mono"
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { api, extractVars } from '../lib/api';
import { useStore } from '../lib/store';
import { AIAssistPanel } from '../components/AIAssistPanel';
import type { CommandTemplate, TargetType, TemplateVar, VarType } from '../lib/types';

const TARGETS: TargetType[] = ['local', 'ssh', 'docker', 'k8s'];

interface InterpreterOption {
  value: string;
  label: string;
  language: string;       // Monaco language id
  ext: string;            // expected file extension when importing
}

const INTERPRETERS: InterpreterOption[] = [
  { value: 'auto',       label: 'Auto (系统 shell, 单条命令)', language: 'shell',      ext: '.sh' },
  { value: 'bash',       label: 'Bash 脚本',                     language: 'shell',      ext: '.sh' },
  { value: 'sh',         label: 'sh 脚本',                       language: 'shell',      ext: '.sh' },
  { value: 'zsh',        label: 'Zsh 脚本',                      language: 'shell',      ext: '.sh' },
  { value: 'powershell', label: 'PowerShell (.ps1)',            language: 'powershell', ext: '.ps1' },
  { value: 'pwsh',       label: 'PowerShell Core (pwsh)',       language: 'powershell', ext: '.ps1' },
  { value: 'python',     label: 'Python',                        language: 'python',     ext: '.py' },
  { value: 'python3',    label: 'Python 3',                      language: 'python',     ext: '.py' },
  { value: 'node',       label: 'Node.js',                       language: 'javascript', ext: '.js' },
  { value: 'ruby',       label: 'Ruby',                          language: 'ruby',       ext: '.rb' },
  { value: 'perl',       label: 'Perl',                          language: 'perl',       ext: '.pl' },
  { value: '__custom__', label: '自定义 (写解释器路径)…',         language: 'plaintext',  ext: '.txt' },
];

function getInterpreterOption(value: string): InterpreterOption {
  return INTERPRETERS.find((o) => o.value === value)
      ?? { value, label: `自定义: ${value}`, language: 'plaintext', ext: '.txt' };
}

function emptyCommand(): Omit<CommandTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    description: '',
    template: '',
    targetType: 'local',
    interpreter: 'auto',
    vars: [],
    tags: [],
    favorite: false,
  };
}

export function CommandEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const reload = useStore((s) => s.reloadCommands);
  const [form, setForm] = useState(emptyCommand());
  const [loading, setLoading] = useState(false);
  const [tagsInput, setTagsInput] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [customInterp, setCustomInterp] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id) return;
    api.getCommand(id).then((c) => {
      const { id: _i, createdAt: _ca, updatedAt: _ua, ...rest } = c;
      setForm({ ...rest, interpreter: rest.interpreter ?? 'auto' });
      setTagsInput(c.tags.join(', '));
      // If interpreter isn't in the built-in list, populate the custom input
      if (rest.interpreter && rest.interpreter !== 'auto' && !INTERPRETERS.find((o) => o.value === rest.interpreter)) {
        setCustomInterp(rest.interpreter);
      }
    });
  }, [id]);

  const detectedVars = useMemo(() => extractVars(form.template), [form.template]);

  useEffect(() => {
    setForm((cur) => {
      const byName = new Map(cur.vars.map((v) => [v.name, v]));
      const next: TemplateVar[] = detectedVars.map((name) =>
        byName.get(name) ?? {
          name,
          label: name,
          type: 'text' as VarType,
          required: true,
          defaultValue: '',
        },
      );
      const sameLength = next.length === cur.vars.length;
      const sameOrder = sameLength && next.every((v, i) => v.name === cur.vars[i].name);
      return sameOrder ? cur : { ...cur, vars: next };
    });
  }, [detectedVars]);

  function setVar(idx: number, patch: Partial<TemplateVar>) {
    setForm((cur) => {
      const vars = cur.vars.slice();
      vars[idx] = { ...vars[idx], ...patch };
      return { ...cur, vars };
    });
  }

  const interpOption = useMemo(
    () => getInterpreterOption(form.interpreter || 'auto'),
    [form.interpreter],
  );
  const isScript = form.interpreter !== 'auto';
  const editorHeight = isScript ? '420px' : '180px';

  function pickInterpreter(value: string) {
    if (value === '__custom__') {
      setForm({ ...form, interpreter: customInterp || 'auto' });
    } else {
      setForm({ ...form, interpreter: value });
    }
  }

  function applyCustomInterp() {
    const v = customInterp.trim();
    if (!v) return;
    setForm({ ...form, interpreter: v });
  }

  async function handleFile(file: File) {
    const text = await file.text();
    // Guess interpreter from extension if user is still on auto
    const ext = file.name.includes('.') ? '.' + file.name.split('.').pop()!.toLowerCase() : '';
    let interpreter = form.interpreter;
    if (interpreter === 'auto') {
      const match = INTERPRETERS.find((o) => o.value !== '__custom__' && o.ext === ext);
      if (match) interpreter = match.value;
    }
    // Strip shebang line; we'll re-add via interpreter machinery
    const lines = text.split('\n');
    let body = text;
    if (lines[0]?.startsWith('#!')) body = lines.slice(1).join('\n');
    setForm({ ...form, template: body, interpreter });
  }

  async function save() {
    if (!form.name.trim() || !form.template.trim()) {
      alert('名称和命令/脚本必填');
      return;
    }
    setLoading(true);
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
      const payload = { ...form, tags };
      if (id) await api.updateCommand(id, payload);
      else await api.createCommand(payload);
      await reload();
      navigate('/');
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // For Monaco language: if user picked a built-in interpreter use that; else infer plaintext
  const monacoLang = interpOption.language;

  // Dropdown value: built-in or '__custom__' if current isn't in the list
  const dropdownValue = INTERPRETERS.find((o) => o.value === form.interpreter) ? form.interpreter : '__custom__';

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex items-center gap-3 mb-5">
          <h1 className="text-xl font-semibold">{id ? '编辑命令' : '新建命令'}</h1>
          <button
            onClick={() => setAiOpen(!aiOpen)}
            className={`ml-auto px-3 py-1.5 rounded text-sm ${aiOpen ? 'bg-emerald-600' : 'bg-ink-800 hover:bg-ink-700'}`}
          >✦ AI 助手</button>
          <button onClick={() => navigate('/')} className="px-3 py-1.5 bg-ink-800 hover:bg-ink-700 rounded text-sm">取消</button>
          <button
            onClick={save}
            disabled={loading}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded text-sm font-medium"
          >{loading ? '保存中…' : '保存'}</button>
        </div>

        <div className="space-y-4 max-w-3xl">
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
              <span className="text-xs text-ink-300">目标类型</span>
              <select
                value={form.targetType}
                onChange={(e) => setForm({ ...form, targetType: e.target.value as TargetType })}
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
              >
                {TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
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

          <label className="block">
            <span className="text-xs text-ink-300">标签 (逗号分隔)</span>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="docker, dev"
              className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
            />
          </label>

          <div className="grid grid-cols-3 gap-3 items-end">
            <label className="block col-span-2">
              <span className="text-xs text-ink-300">解释器 / 执行方式</span>
              <select
                value={dropdownValue}
                onChange={(e) => pickInterpreter(e.target.value)}
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
              >
                {INTERPRETERS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {dropdownValue === '__custom__' && (
              <div className="flex gap-1">
                <input
                  value={customInterp}
                  onChange={(e) => setCustomInterp(e.target.value)}
                  placeholder="e.g. /usr/bin/env zx"
                  className="flex-1 bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm font-mono"
                />
                <button
                  onClick={applyCustomInterp}
                  className="px-2 bg-ink-800 hover:bg-ink-700 rounded text-xs"
                >应用</button>
              </div>
            )}
          </div>

          <div>
            <div className="text-xs text-ink-300 mb-1 flex items-center gap-2">
              <span>{isScript ? '脚本内容 *' : '命令模板 *'}</span>
              <span className="text-ink-500">
                {isScript
                  ? `保存为 ${interpOption.ext} 临时文件，用 ${form.interpreter} 执行`
                  : '会作为单条命令传给系统 shell'}
              </span>
              <span className="text-ink-500">·</span>
              <span className="text-ink-500">变量：<code className="bg-ink-800 px-1 rounded">{`{{name}}`}</code></span>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="ml-auto text-xs text-emerald-400 hover:text-emerald-300"
              >📂 从文件导入…</button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".sh,.bash,.zsh,.ps1,.py,.js,.mjs,.cjs,.rb,.pl,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="border border-ink-700 rounded overflow-hidden">
              <Editor
                height={editorHeight}
                language={monacoLang}
                theme="vs-dark"
                value={form.template}
                onChange={(v) => setForm({ ...form, template: v ?? '' })}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  lineNumbers: isScript ? 'on' : 'off',
                  scrollBeyondLastLine: false,
                  tabSize: 2,
                }}
              />
            </div>
          </div>

          {form.vars.length > 0 && (
            <div>
              <div className="text-xs text-ink-300 mb-2">变量定义</div>
              <div className="space-y-2">
                {form.vars.map((v, i) => (
                  <div key={v.name} className="grid grid-cols-12 gap-2 items-center bg-ink-900 border border-ink-800 rounded p-2">
                    <div className="col-span-2 text-xs font-mono text-emerald-300">{`{{${v.name}}}`}</div>
                    <input
                      value={v.label}
                      onChange={(e) => setVar(i, { label: e.target.value })}
                      placeholder="显示名"
                      className="col-span-3 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                    />
                    <select
                      value={v.type}
                      onChange={(e) => setVar(i, { type: e.target.value as VarType })}
                      className="col-span-2 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                    >
                      <option value="text">text</option>
                      <option value="number">number</option>
                      <option value="select">select</option>
                      <option value="boolean">boolean</option>
                    </select>
                    <input
                      value={v.defaultValue ?? ''}
                      onChange={(e) => setVar(i, { defaultValue: e.target.value })}
                      placeholder="默认值"
                      className="col-span-3 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                    />
                    <label className="col-span-2 flex items-center gap-1 text-xs text-ink-400">
                      <input
                        type="checkbox"
                        checked={v.required}
                        onChange={(e) => setVar(i, { required: e.target.checked })}
                        className="accent-emerald-500"
                      /> 必填
                    </label>
                    {v.type === 'select' && (
                      <input
                        value={v.options?.join(',') ?? ''}
                        onChange={(e) => setVar(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                        placeholder="选项,逗号分隔"
                        className="col-span-12 bg-ink-950 border border-ink-700 rounded px-2 py-1 text-xs"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {aiOpen && (
        <div className="w-96 border-l border-ink-800 p-3">
          <AIAssistPanel
            context={{ targetType: form.targetType, currentCommand: form.template }}
            onInsert={(code) => setForm((cur) => ({ ...cur, template: code }))}
          />
        </div>
      )}
    </div>
  );
}

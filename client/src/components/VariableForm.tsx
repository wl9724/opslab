import type { TemplateVar } from '../lib/types';

interface Props {
  vars: TemplateVar[];
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

export function VariableForm({ vars, values, onChange }: Props) {
  if (vars.length === 0) {
    return <div className="text-sm text-ink-500">该命令无变量</div>;
  }
  return (
    <div className="space-y-3">
      {vars.map((v) => {
        const value = values[v.name] ?? v.defaultValue ?? '';
        const setVal = (newVal: string) => onChange({ ...values, [v.name]: newVal });
        return (
          <label key={v.name} className="block">
            <div className="text-xs text-ink-300 mb-1 flex items-center gap-2">
              <span>{v.label || v.name}</span>
              {v.required && <span className="text-red-400">*</span>}
              <span className="text-ink-500 font-mono">{`{{${v.name}}}`}</span>
            </div>
            {v.type === 'select' && v.options ? (
              <select
                value={value}
                onChange={(e) => setVal(e.target.value)}
                className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm"
              >
                <option value="">--</option>
                {v.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : v.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={value === 'true'}
                onChange={(e) => setVal(e.target.checked ? 'true' : 'false')}
                className="h-4 w-4 accent-emerald-500"
              />
            ) : (
              <input
                type={v.type === 'number' ? 'number' : 'text'}
                value={value}
                onChange={(e) => setVal(e.target.value)}
                placeholder={v.defaultValue}
                className="w-full bg-ink-900 border border-ink-700 rounded px-2 py-1.5 text-sm font-mono"
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

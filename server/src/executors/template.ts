import type { TemplateVar } from '../types.js';

const VAR_RE = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;

export interface RenderResult {
  rendered: string;
  missing: string[];
}

export function extractVariables(template: string): string[] {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(template)) !== null) {
    set.add(m[1]);
  }
  return [...set];
}

export function render(template: string, values: Record<string, string>): RenderResult {
  const missing: string[] = [];
  const rendered = template.replace(VAR_RE, (_full, name: string) => {
    const v = values[name];
    if (v === undefined || v === '') {
      missing.push(name);
      return '';
    }
    return v;
  });
  return { rendered, missing };
}

export function validateValues(
  vars: TemplateVar[],
  values: Record<string, string>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const v of vars) {
    const raw = values[v.name];
    if (v.required && (raw === undefined || raw === '')) {
      errors.push(`${v.label || v.name} is required`);
      continue;
    }
    if (raw === undefined || raw === '') continue;
    if (v.type === 'number' && Number.isNaN(Number(raw))) {
      errors.push(`${v.label || v.name} must be a number`);
    }
    if (v.type === 'select' && v.options && !v.options.includes(raw)) {
      errors.push(`${v.label || v.name} must be one of: ${v.options.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

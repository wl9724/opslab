import type {
  CommandTemplate,
  Connection,
  Execution,
  AIProvider,
  TemplateVar,
  TargetType,
  SafetyResult,
  Playbook,
  BackupFile,
  ImportSummary,
  DebugLogEntry,
  DebugLogLevel,
  DebugState,
} from './types';

function getToken(): string {
  const fromUrl = new URL(window.location.href).searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('opslab.token', fromUrl);
    return fromUrl;
  }
  return localStorage.getItem('opslab.token') ?? '';
}

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-opslab-token': getToken(),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.text();
  let parsed: any;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  if (!res.ok) {
    const msg = parsed?.error
      ? typeof parsed.error === 'string'
        ? parsed.error
        : JSON.stringify(parsed.error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

export const api = {
  token: getToken,

  health: () => request<{ ok: boolean }>('/health'),
  me: () => request<{ os: string; shell: string }>('/me'),

  // commands
  listCommands: () => request<CommandTemplate[]>('/commands'),
  getCommand: (id: string) => request<CommandTemplate>(`/commands/${id}`),
  createCommand: (input: Omit<CommandTemplate, 'id' | 'createdAt' | 'updatedAt'>) =>
    request<CommandTemplate>('/commands', { method: 'POST', body: JSON.stringify(input) }),
  updateCommand: (id: string, patch: Partial<CommandTemplate>) =>
    request<CommandTemplate>(`/commands/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteCommand: (id: string) => request<void>(`/commands/${id}`, { method: 'DELETE' }),

  // connections
  listConnections: () => request<Connection[]>('/connections'),
  createConnection: (input: any) =>
    request<Connection>('/connections', { method: 'POST', body: JSON.stringify(input) }),
  updateConnection: (id: string, patch: any) =>
    request<Connection>(`/connections/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),
  testConnection: (id: string) =>
    request<{ ok: boolean; message: string }>(`/connections/${id}/test`, { method: 'POST' }),

  // executions
  listExecutions: (limit = 50, commandId?: string) => {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (commandId) q.set('commandId', commandId);
    return request<Execution[]>(`/executions?${q.toString()}`);
  },
  getExecution: (id: string) => request<Execution & { output: string }>(`/executions/${id}`),

  // run
  run: (input: {
    commandId?: string;
    connectionId?: string;
    template?: string;
    interpreter?: string;
    values?: Record<string, string>;
    confirmDanger?: boolean;
  }) =>
    request<{ execution: Execution; safety: SafetyResult }>('/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  stop: (executionId: string) =>
    request<{ ok: boolean }>(`/run/${executionId}/stop`, { method: 'POST' }),

  fanout: (input: {
    commandId?: string;
    template?: string;
    connectionIds: string[];
    values?: Record<string, string>;
    confirmDanger?: boolean;
  }) =>
    request<{
      results: Array<
        | { connectionId: string; ok: true; execution: Execution; safety: SafetyResult }
        | { connectionId: string; ok: false; error: string }
      >;
    }>('/run/fanout', { method: 'POST', body: JSON.stringify(input) }),

  // playbooks
  listPlaybooks: () => request<Playbook[]>('/playbooks'),
  getPlaybook: (id: string) => request<Playbook>(`/playbooks/${id}`),
  createPlaybook: (input: Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>) =>
    request<Playbook>('/playbooks', { method: 'POST', body: JSON.stringify(input) }),
  updatePlaybook: (id: string, patch: Partial<Playbook>) =>
    request<Playbook>(`/playbooks/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deletePlaybook: (id: string) => request<void>(`/playbooks/${id}`, { method: 'DELETE' }),
  runPlaybook: (input: {
    playbookId?: string;
    inline?: Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>;
    initialValues?: Record<string, string>;
    confirmDanger?: boolean;
  }) => request<{ playbookRunId: string; playbook: Playbook }>('/playbooks/run', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  abortPlaybook: (playbookRunId: string) =>
    request<{ ok: boolean }>(`/playbooks/run/${playbookRunId}/abort`, { method: 'POST' }),

  // debug
  debugLogs: (params?: { level?: DebugLogLevel; scope?: string; q?: string; afterId?: number; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.level) q.set('level', params.level);
    if (params?.scope) q.set('scope', params.scope);
    if (params?.q) q.set('q', params.q);
    if (params?.afterId !== undefined) q.set('afterId', String(params.afterId));
    if (params?.limit !== undefined) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<{ entries: DebugLogEntry[]; total: number; scopes: string[]; debugEnabled: boolean }>(
      `/debug/logs${qs ? `?${qs}` : ''}`,
    );
  },
  debugState: () => request<DebugState>('/debug/state'),
  setDebugEnabled: (enabled: boolean) =>
    request<{ debugEnabled: boolean }>('/debug/config', { method: 'POST', body: JSON.stringify({ enabled }) }),
  clearDebugLogs: () => request<{ cleared: number }>('/debug/clear', { method: 'POST' }),

  // ai
  listProviders: () => request<AIProvider[]>('/ai/providers'),
  createProvider: (input: any) =>
    request<AIProvider>('/ai/providers', { method: 'POST', body: JSON.stringify(input) }),
  updateProvider: (id: string, patch: any) =>
    request<AIProvider>(`/ai/providers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteProvider: (id: string) => request<void>(`/ai/providers/${id}`, { method: 'DELETE' }),

  // backup (one-click export / import of all config)
  exportBackup: (secrets: boolean) =>
    request<BackupFile>(`/backup/export?secrets=${secrets ? 1 : 0}`),
  importBackup: (data: unknown, mode: 'merge' | 'replace') =>
    request<ImportSummary>('/backup/import', {
      method: 'POST',
      body: JSON.stringify({ data, mode }),
    }),

  chat: async function* (req: {
    providerId?: string;
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    context?: any;
  }): AsyncGenerator<{ type: 'text'; delta: string } | { type: 'error'; message: string } | { type: 'done' }> {
    const res = await fetch(`${API_BASE}/ai/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-opslab-token': getToken(),
      },
      body: JSON.stringify(req),
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      yield { type: 'error', message: text || `HTTP ${res.status}` };
      yield { type: 'done' };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload);
            yield ev;
            if (ev.type === 'done') return;
          } catch {
            /* swallow */
          }
        }
      }
    }
  },
};

export function extractVars(template: string): string[] {
  const re = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) set.add(m[1]);
  return [...set];
}

export function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  const out: Array<{ lang: string; code: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ lang: m[1] || 'sh', code: m[2].trim() });
  }
  return out;
}

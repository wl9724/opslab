export type TargetType = 'local' | 'ssh' | 'docker' | 'k8s';
export type VarType = 'text' | 'number' | 'select' | 'boolean';

export interface TemplateVar {
  name: string;
  label: string;
  type: VarType;
  defaultValue?: string;
  options?: string[];
  required: boolean;
}

export interface CommandTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  targetType: TargetType;
  interpreter: string;
  vars: TemplateVar[];
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ConnectionType = 'local' | 'ssh';
export type SSHAuthType = 'password' | 'privateKey';

export interface Connection {
  id: string;
  name: string;
  type: ConnectionType;
  host?: string;
  port?: number;
  username?: string;
  authType?: SSHAuthType;
  createdAt: string;
}

export type ExecStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface Execution {
  id: string;
  commandId: string | null;
  connectionId: string;
  renderedCmd: string;
  status: ExecStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  outputBytes: number;
}

export type AIProviderType = 'claude' | 'openai' | 'ollama';

export interface AIProvider {
  id: string;
  name: string;
  type: AIProviderType;
  baseUrl?: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
}

export interface SafetyResult {
  level: 'safe' | 'warning' | 'danger';
  reasons: string[];
}

export interface PlaybookStep {
  id: string;
  commandId: string | null;
  inlineTemplate?: string;
  connectionId?: string;
  values?: Record<string, string>;
  continueOnError: boolean;
  captureAs?: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  defaultConnectionId?: string;
  steps: PlaybookStep[];
  createdAt: string;
  updatedAt: string;
}

export type PlaybookEvent =
  | { type: 'step-start'; playbookRunId: string; index: number; executionId: string; renderedCmd: string }
  | { type: 'chunk'; playbookRunId: string; index: number; executionId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'step-done'; playbookRunId: string; index: number; executionId: string; status: ExecStatus; exitCode: number | null; captured?: { name: string; value: string } }
  | { type: 'step-skipped'; playbookRunId: string; index: number; reason: string }
  | { type: 'done'; playbookRunId: string; status: 'completed' | 'failed' | 'aborted'; capturedVars: Record<string, string> };

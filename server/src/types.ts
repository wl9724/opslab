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

/** Interpreter for executing the template body.
 * - 'auto': default; run as a single string in the OS default shell (bash -lc / powershell -Command).
 * - 'bash' | 'sh' | 'powershell' | 'pwsh' | 'python' | 'python3' | 'node' | 'ruby': run as a script in that interpreter.
 * - any other string: treated as an absolute path or interpreter on PATH (e.g., '/usr/bin/env zx').
 */
export type Interpreter = 'auto' | 'bash' | 'sh' | 'powershell' | 'pwsh' | 'python' | 'python3' | 'node' | 'ruby' | string;

export interface CommandTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  targetType: TargetType;
  /** default 'auto' = single-line command via OS shell */
  interpreter: Interpreter;
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
  secretRef?: string;
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
  secretRef?: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  providerId: string;
  messages: AIChatMessage[];
  context?: {
    os?: string;
    shell?: string;
    targetType?: TargetType;
    connectionName?: string;
    currentCommand?: string;
  };
}

export interface PlaybookStep {
  id: string;
  /** id of a saved CommandTemplate, OR null for inline */
  commandId: string | null;
  /** inline template if commandId is null */
  inlineTemplate?: string;
  /** connection to run on; if null, use playbook's default */
  connectionId?: string;
  /** override values for the command's vars */
  values?: Record<string, string>;
  /** if true, playbook continues even if this step fails */
  continueOnError: boolean;
  /** if set, captures stdout (trimmed) into a variable available to later steps */
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

export type PlaybookRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface PlaybookStepResult {
  index: number;
  step: PlaybookStep;
  executionId: string | null;
  status: ExecStatus | 'skipped';
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PlaybookRun {
  id: string;
  playbookId: string | null;
  status: PlaybookRunStatus;
  startedAt: string;
  endedAt: string | null;
  steps: PlaybookStepResult[];
  capturedVars: Record<string, string>;
}

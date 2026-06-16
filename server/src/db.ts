import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { DB_PATH } from './config.js';
import type {
  CommandTemplate,
  Connection,
  Execution,
  AIProvider,
  TemplateVar,
  TargetType,
  ConnectionType,
  SSHAuthType,
  AIProviderType,
  ExecStatus,
  Playbook,
  PlaybookStep,
} from './types.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS commands (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  template     TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  interpreter  TEXT NOT NULL DEFAULT 'auto',
  vars_json    TEXT NOT NULL DEFAULT '[]',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  favorite     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  host         TEXT,
  port         INTEGER,
  username     TEXT,
  auth_type    TEXT,
  secret_ref   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id            TEXT PRIMARY KEY,
  command_id    TEXT,
  connection_id TEXT NOT NULL,
  rendered_cmd  TEXT NOT NULL,
  status        TEXT NOT NULL,
  exit_code     INTEGER,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  output_bytes  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS executions_started_idx ON executions(started_at DESC);

CREATE TABLE IF NOT EXISTS ai_providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  base_url    TEXT,
  model       TEXT NOT NULL,
  secret_ref  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playbooks (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  default_connection_id  TEXT,
  steps_json             TEXT NOT NULL DEFAULT '[]',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
`);

// Lightweight migrations for users who upgraded
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('commands', 'interpreter', "interpreter TEXT NOT NULL DEFAULT 'auto'");

function now(): string {
  return new Date().toISOString();
}

function rowToCommand(r: any): CommandTemplate {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    template: r.template,
    targetType: r.target_type as TargetType,
    interpreter: r.interpreter ?? 'auto',
    vars: JSON.parse(r.vars_json) as TemplateVar[],
    tags: JSON.parse(r.tags_json) as string[],
    favorite: r.favorite === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const commandsRepo = {
  list(): CommandTemplate[] {
    const rows = db.prepare('SELECT * FROM commands ORDER BY favorite DESC, updated_at DESC').all();
    return rows.map(rowToCommand);
  },
  get(id: string): CommandTemplate | null {
    const r = db.prepare('SELECT * FROM commands WHERE id = ?').get(id);
    return r ? rowToCommand(r) : null;
  },
  create(input: Omit<CommandTemplate, 'id' | 'createdAt' | 'updatedAt'>): CommandTemplate {
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO commands (id, name, description, template, target_type, interpreter, vars_json, tags_json, favorite, created_at, updated_at)
       VALUES (@id, @name, @description, @template, @target_type, @interpreter, @vars_json, @tags_json, @favorite, @ts, @ts)`,
    ).run({
      id,
      name: input.name,
      description: input.description,
      template: input.template,
      target_type: input.targetType,
      interpreter: input.interpreter ?? 'auto',
      vars_json: JSON.stringify(input.vars),
      tags_json: JSON.stringify(input.tags),
      favorite: input.favorite ? 1 : 0,
      ts,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Omit<CommandTemplate, 'id' | 'createdAt'>>): CommandTemplate | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch, updatedAt: now() };
    db.prepare(
      `UPDATE commands SET name=@name, description=@description, template=@template,
        target_type=@target_type, interpreter=@interpreter, vars_json=@vars_json, tags_json=@tags_json,
        favorite=@favorite, updated_at=@updated_at WHERE id=@id`,
    ).run({
      id,
      name: merged.name,
      description: merged.description,
      template: merged.template,
      target_type: merged.targetType,
      interpreter: merged.interpreter ?? 'auto',
      vars_json: JSON.stringify(merged.vars),
      tags_json: JSON.stringify(merged.tags),
      favorite: merged.favorite ? 1 : 0,
      updated_at: merged.updatedAt,
    });
    return this.get(id);
  },
  delete(id: string): boolean {
    return db.prepare('DELETE FROM commands WHERE id = ?').run(id).changes > 0;
  },
  /** Insert or replace a full row, preserving id/timestamps. Used by backup import. */
  upsert(c: CommandTemplate): void {
    db.prepare(
      `INSERT OR REPLACE INTO commands (id, name, description, template, target_type, interpreter, vars_json, tags_json, favorite, created_at, updated_at)
       VALUES (@id, @name, @description, @template, @target_type, @interpreter, @vars_json, @tags_json, @favorite, @created_at, @updated_at)`,
    ).run({
      id: c.id,
      name: c.name,
      description: c.description,
      template: c.template,
      target_type: c.targetType,
      interpreter: c.interpreter ?? 'auto',
      vars_json: JSON.stringify(c.vars ?? []),
      tags_json: JSON.stringify(c.tags ?? []),
      favorite: c.favorite ? 1 : 0,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    });
  },
  clear(): void {
    db.exec('DELETE FROM commands');
  },
};

function rowToConnection(r: any): Connection {
  return {
    id: r.id,
    name: r.name,
    type: r.type as ConnectionType,
    host: r.host ?? undefined,
    port: r.port ?? undefined,
    username: r.username ?? undefined,
    authType: (r.auth_type as SSHAuthType | null) ?? undefined,
    secretRef: r.secret_ref ?? undefined,
    createdAt: r.created_at,
  };
}

export const connectionsRepo = {
  list(): Connection[] {
    return db.prepare('SELECT * FROM connections ORDER BY created_at DESC').all().map(rowToConnection);
  },
  get(id: string): Connection | null {
    const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    return r ? rowToConnection(r) : null;
  },
  create(input: Omit<Connection, 'id' | 'createdAt'>): Connection {
    const id = nanoid(12);
    db.prepare(
      `INSERT INTO connections (id, name, type, host, port, username, auth_type, secret_ref, created_at)
       VALUES (@id, @name, @type, @host, @port, @username, @auth_type, @secret_ref, @created_at)`,
    ).run({
      id,
      name: input.name,
      type: input.type,
      host: input.host ?? null,
      port: input.port ?? null,
      username: input.username ?? null,
      auth_type: input.authType ?? null,
      secret_ref: input.secretRef ?? null,
      created_at: now(),
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Omit<Connection, 'id' | 'createdAt'>>): Connection | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    db.prepare(
      `UPDATE connections SET name=@name, type=@type, host=@host, port=@port,
        username=@username, auth_type=@auth_type, secret_ref=@secret_ref WHERE id=@id`,
    ).run({
      id,
      name: merged.name,
      type: merged.type,
      host: merged.host ?? null,
      port: merged.port ?? null,
      username: merged.username ?? null,
      auth_type: merged.authType ?? null,
      secret_ref: merged.secretRef ?? null,
    });
    return this.get(id);
  },
  delete(id: string): boolean {
    return db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
  },
  upsert(c: Connection): void {
    db.prepare(
      `INSERT OR REPLACE INTO connections (id, name, type, host, port, username, auth_type, secret_ref, created_at)
       VALUES (@id, @name, @type, @host, @port, @username, @auth_type, @secret_ref, @created_at)`,
    ).run({
      id: c.id,
      name: c.name,
      type: c.type,
      host: c.host ?? null,
      port: c.port ?? null,
      username: c.username ?? null,
      auth_type: c.authType ?? null,
      secret_ref: c.secretRef ?? null,
      created_at: c.createdAt,
    });
  },
  clear(): void {
    db.exec('DELETE FROM connections');
  },
};

function rowToExecution(r: any): Execution {
  return {
    id: r.id,
    commandId: r.command_id,
    connectionId: r.connection_id,
    renderedCmd: r.rendered_cmd,
    status: r.status as ExecStatus,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outputBytes: r.output_bytes,
  };
}

export const executionsRepo = {
  list(limit = 50, commandId?: string): Execution[] {
    if (commandId) {
      return db
        .prepare('SELECT * FROM executions WHERE command_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(commandId, limit)
        .map(rowToExecution);
    }
    return db
      .prepare('SELECT * FROM executions ORDER BY started_at DESC LIMIT ?')
      .all(limit)
      .map(rowToExecution);
  },
  get(id: string): Execution | null {
    const r = db.prepare('SELECT * FROM executions WHERE id = ?').get(id);
    return r ? rowToExecution(r) : null;
  },
  create(input: Omit<Execution, 'startedAt' | 'endedAt' | 'outputBytes'> & { startedAt?: string }): Execution {
    db.prepare(
      `INSERT INTO executions (id, command_id, connection_id, rendered_cmd, status, exit_code, started_at, output_bytes)
       VALUES (@id, @command_id, @connection_id, @rendered_cmd, @status, @exit_code, @started_at, 0)`,
    ).run({
      id: input.id,
      command_id: input.commandId,
      connection_id: input.connectionId,
      rendered_cmd: input.renderedCmd,
      status: input.status,
      exit_code: input.exitCode,
      started_at: input.startedAt ?? now(),
    });
    return this.get(input.id)!;
  },
  finish(id: string, status: ExecStatus, exitCode: number | null, outputBytes: number): void {
    db.prepare(
      `UPDATE executions SET status=?, exit_code=?, ended_at=?, output_bytes=? WHERE id=?`,
    ).run(status, exitCode, now(), outputBytes, id);
  },
};

function rowToProvider(r: any): AIProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type as AIProviderType,
    baseUrl: r.base_url ?? undefined,
    model: r.model,
    secretRef: r.secret_ref ?? undefined,
    enabled: r.enabled === 1,
    isDefault: r.is_default === 1,
  };
}

export const providersRepo = {
  list(): AIProvider[] {
    return db.prepare('SELECT * FROM ai_providers ORDER BY is_default DESC, name ASC').all().map(rowToProvider);
  },
  get(id: string): AIProvider | null {
    const r = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id);
    return r ? rowToProvider(r) : null;
  },
  getDefault(): AIProvider | null {
    const r = db.prepare('SELECT * FROM ai_providers WHERE is_default = 1 AND enabled = 1 LIMIT 1').get();
    return r ? rowToProvider(r) : null;
  },
  create(input: Omit<AIProvider, 'id'>): AIProvider {
    const id = nanoid(12);
    if (input.isDefault) {
      db.prepare('UPDATE ai_providers SET is_default = 0').run();
    }
    db.prepare(
      `INSERT INTO ai_providers (id, name, type, base_url, model, secret_ref, enabled, is_default)
       VALUES (@id, @name, @type, @base_url, @model, @secret_ref, @enabled, @is_default)`,
    ).run({
      id,
      name: input.name,
      type: input.type,
      base_url: input.baseUrl ?? null,
      model: input.model,
      secret_ref: input.secretRef ?? null,
      enabled: input.enabled ? 1 : 0,
      is_default: input.isDefault ? 1 : 0,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Omit<AIProvider, 'id'>>): AIProvider | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch };
    if (merged.isDefault) {
      db.prepare('UPDATE ai_providers SET is_default = 0 WHERE id != ?').run(id);
    }
    db.prepare(
      `UPDATE ai_providers SET name=@name, type=@type, base_url=@base_url, model=@model,
        secret_ref=@secret_ref, enabled=@enabled, is_default=@is_default WHERE id=@id`,
    ).run({
      id,
      name: merged.name,
      type: merged.type,
      base_url: merged.baseUrl ?? null,
      model: merged.model,
      secret_ref: merged.secretRef ?? null,
      enabled: merged.enabled ? 1 : 0,
      is_default: merged.isDefault ? 1 : 0,
    });
    return this.get(id);
  },
  delete(id: string): boolean {
    return db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id).changes > 0;
  },
  upsert(p: AIProvider): void {
    db.prepare(
      `INSERT OR REPLACE INTO ai_providers (id, name, type, base_url, model, secret_ref, enabled, is_default)
       VALUES (@id, @name, @type, @base_url, @model, @secret_ref, @enabled, @is_default)`,
    ).run({
      id: p.id,
      name: p.name,
      type: p.type,
      base_url: p.baseUrl ?? null,
      model: p.model,
      secret_ref: p.secretRef ?? null,
      enabled: p.enabled ? 1 : 0,
      is_default: p.isDefault ? 1 : 0,
    });
  },
  clear(): void {
    db.exec('DELETE FROM ai_providers');
  },
};

function rowToPlaybook(r: any): Playbook {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    defaultConnectionId: r.default_connection_id ?? undefined,
    steps: JSON.parse(r.steps_json) as PlaybookStep[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const playbooksRepo = {
  list(): Playbook[] {
    return db.prepare('SELECT * FROM playbooks ORDER BY updated_at DESC').all().map(rowToPlaybook);
  },
  get(id: string): Playbook | null {
    const r = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(id);
    return r ? rowToPlaybook(r) : null;
  },
  create(input: Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>): Playbook {
    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `INSERT INTO playbooks (id, name, description, default_connection_id, steps_json, created_at, updated_at)
       VALUES (@id, @name, @description, @default_connection_id, @steps_json, @ts, @ts)`,
    ).run({
      id,
      name: input.name,
      description: input.description,
      default_connection_id: input.defaultConnectionId ?? null,
      steps_json: JSON.stringify(input.steps ?? []),
      ts,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Omit<Playbook, 'id' | 'createdAt'>>): Playbook | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch, updatedAt: now() };
    db.prepare(
      `UPDATE playbooks SET name=@name, description=@description, default_connection_id=@default_connection_id,
        steps_json=@steps_json, updated_at=@updated_at WHERE id=@id`,
    ).run({
      id,
      name: merged.name,
      description: merged.description,
      default_connection_id: merged.defaultConnectionId ?? null,
      steps_json: JSON.stringify(merged.steps),
      updated_at: merged.updatedAt,
    });
    return this.get(id);
  },
  delete(id: string): boolean {
    return db.prepare('DELETE FROM playbooks WHERE id = ?').run(id).changes > 0;
  },
  upsert(p: Playbook): void {
    db.prepare(
      `INSERT OR REPLACE INTO playbooks (id, name, description, default_connection_id, steps_json, created_at, updated_at)
       VALUES (@id, @name, @description, @default_connection_id, @steps_json, @created_at, @updated_at)`,
    ).run({
      id: p.id,
      name: p.name,
      description: p.description,
      default_connection_id: p.defaultConnectionId ?? null,
      steps_json: JSON.stringify(p.steps ?? []),
      created_at: p.createdAt,
      updated_at: p.updatedAt,
    });
  },
  clear(): void {
    db.exec('DELETE FROM playbooks');
  },
};

export function ensureLocalConnection(): Connection {
  const existing = db
    .prepare("SELECT * FROM connections WHERE type = 'local' LIMIT 1")
    .get();
  if (existing) return rowToConnection(existing);
  return connectionsRepo.create({
    name: 'Local',
    type: 'local',
  });
}

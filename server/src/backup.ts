import { z } from 'zod';
import { nanoid } from 'nanoid';
import {
  commandsRepo,
  connectionsRepo,
  playbooksRepo,
  providersRepo,
  ensureLocalConnection,
} from './db.js';
import { getSecret, setSecret, deleteSecret } from './secrets.js';
import type { CommandTemplate, Connection, Playbook, AIProvider, PlaybookStep } from './types.js';

export const BACKUP_VERSION = 1;

export type ImportMode = 'merge' | 'replace';

/** A connection/provider in the backup carries a `hasSecret` flag so the UI can tell the user
 * which items need their password/key re-entered after a secret-less import. The plaintext
 * value is only present when the backup was exported with `includeSecrets`. */
type BackupConnection = Omit<Connection, 'secretRef'> & { hasSecret: boolean; secretRef?: string; secret?: string };
type BackupProvider = Omit<AIProvider, 'secretRef'> & { hasSecret: boolean; secretRef?: string; apiKey?: string };

export interface BackupFile {
  opslab: 'backup';
  version: number;
  exportedAt: string;
  includesSecrets: boolean;
  data: {
    commands: CommandTemplate[];
    connections: BackupConnection[];
    playbooks: Playbook[];
    providers: BackupProvider[];
  };
}

export interface ImportSummary {
  mode: ImportMode;
  imported: { commands: number; connections: number; playbooks: number; providers: number };
  secretsRestored: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportBackup(includeSecrets: boolean): BackupFile {
  const commands = commandsRepo.list();
  const playbooks = playbooksRepo.list();

  const connections: BackupConnection[] = connectionsRepo.list().map((c) => {
    const value = c.secretRef ? getSecret(c.secretRef) : undefined;
    const out: BackupConnection = { ...c, hasSecret: value !== undefined };
    delete out.secretRef;
    if (includeSecrets && value !== undefined) {
      out.secret = value;
      out.secretRef = c.secretRef;
    }
    return out;
  });

  const providers: BackupProvider[] = providersRepo.list().map((p) => {
    const value = p.secretRef ? getSecret(p.secretRef) : undefined;
    const out: BackupProvider = { ...p, hasSecret: value !== undefined };
    delete out.secretRef;
    if (includeSecrets && value !== undefined) {
      out.apiKey = value;
      out.secretRef = p.secretRef;
    }
    return out;
  });

  return {
    opslab: 'backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    data: { commands, connections, playbooks, providers },
  };
}

// ---------------------------------------------------------------------------
// Import — lenient schemas (a hand-edited file shouldn't hard-fail the whole import)
// ---------------------------------------------------------------------------

const VarImport = z
  .object({
    name: z.string(),
    label: z.string().default(''),
    type: z.enum(['text', 'number', 'select', 'boolean']).catch('text'),
    defaultValue: z.string().optional(),
    options: z.array(z.string()).optional(),
    required: z.boolean().default(false),
  })
  .passthrough();

const CommandImport = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    template: z.string().default(''),
    targetType: z.enum(['local', 'ssh', 'docker', 'k8s']).catch('local'),
    interpreter: z.string().default('auto'),
    vars: z.array(VarImport).default([]),
    tags: z.array(z.string()).default([]),
    favorite: z.boolean().default(false),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const ConnectionImport = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['local', 'ssh']).catch('ssh'),
    host: z.string().optional(),
    port: z.number().int().optional(),
    username: z.string().optional(),
    authType: z.enum(['password', 'privateKey']).optional(),
    secret: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const ProviderImport = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['claude', 'openai', 'ollama']).catch('openai'),
    baseUrl: z.string().optional(),
    model: z.string().default(''),
    enabled: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    apiKey: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const StepImport = z
  .object({
    id: z.string().optional(),
    commandId: z.string().nullable().optional(),
    inlineTemplate: z.string().optional(),
    connectionId: z.string().optional(),
    values: z.record(z.string()).optional(),
    continueOnError: z.boolean().default(false),
    captureAs: z.string().optional(),
  })
  .passthrough();

const PlaybookImport = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    defaultConnectionId: z.string().optional(),
    steps: z.array(StepImport).default([]),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const EnvelopeSchema = z.object({
  data: z.object({
    commands: z.array(z.unknown()).default([]),
    connections: z.array(z.unknown()).default([]),
    playbooks: z.array(z.unknown()).default([]),
    providers: z.array(z.unknown()).default([]),
  }),
});

export function importBackup(raw: unknown, mode: ImportMode): ImportSummary {
  const env = EnvelopeSchema.parse(raw); // throws on a structurally invalid file → route maps to 400
  const data = env.data;
  const ts = new Date().toISOString();
  let skipped = 0;
  let secretsRestored = 0;

  if (mode === 'replace') {
    // Drop everything (and its secrets) so the import is a faithful restore.
    for (const c of connectionsRepo.list()) if (c.secretRef) deleteSecret(c.secretRef);
    for (const p of providersRepo.list()) if (p.secretRef) deleteSecret(p.secretRef);
    playbooksRepo.clear();
    commandsRepo.clear();
    providersRepo.clear();
    connectionsRepo.clear();
  }

  // The target machine always has exactly one canonical local connection; fold any imported
  // `local` into it (and remap playbook references) instead of creating a duplicate.
  const localConn = ensureLocalConnection();
  const connMap: Record<string, string> = {};

  // --- connections ---
  let nConn = 0;
  for (const item of data.connections) {
    const parsed = ConnectionImport.safeParse(item);
    if (!parsed.success) { skipped++; continue; }
    const c = parsed.data;
    if (c.type === 'local') {
      connMap[c.id] = localConn.id;
      continue;
    }
    // Preserve any existing secret unless the file carries a new plaintext value.
    let secretRef = connectionsRepo.get(c.id)?.secretRef;
    if (c.secret !== undefined) {
      if (!secretRef) secretRef = `conn:${nanoid(10)}`;
      setSecret(secretRef, c.secret);
      secretsRestored++;
    }
    connectionsRepo.upsert({
      id: c.id,
      name: c.name,
      type: c.type,
      host: c.host,
      port: c.port,
      username: c.username,
      authType: c.authType,
      secretRef,
      createdAt: c.createdAt ?? ts,
    });
    connMap[c.id] = c.id;
    nConn++;
  }

  // --- commands ---
  let nCmd = 0;
  for (const item of data.commands) {
    const parsed = CommandImport.safeParse(item);
    if (!parsed.success) { skipped++; continue; }
    const c = parsed.data;
    commandsRepo.upsert({
      id: c.id,
      name: c.name,
      description: c.description,
      template: c.template,
      targetType: c.targetType,
      interpreter: c.interpreter,
      vars: c.vars,
      tags: c.tags,
      favorite: c.favorite,
      createdAt: c.createdAt ?? ts,
      updatedAt: c.updatedAt ?? ts,
    });
    nCmd++;
  }

  // --- providers ---
  let nProv = 0;
  let lastDefault: string | undefined;
  for (const item of data.providers) {
    const parsed = ProviderImport.safeParse(item);
    if (!parsed.success) { skipped++; continue; }
    const p = parsed.data;
    let secretRef = providersRepo.get(p.id)?.secretRef;
    if (p.apiKey !== undefined) {
      if (!secretRef) secretRef = `ai:${nanoid(10)}`;
      setSecret(secretRef, p.apiKey);
      secretsRestored++;
    }
    providersRepo.upsert({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      secretRef,
      enabled: p.enabled,
      isDefault: p.isDefault,
    });
    if (p.isDefault) lastDefault = p.id;
    nProv++;
  }
  // Re-assert a single default so a merge can't leave two providers flagged default.
  if (lastDefault) providersRepo.update(lastDefault, { isDefault: true });

  // --- playbooks (rewrite connection refs through connMap; command ids are preserved 1:1) ---
  let nPb = 0;
  for (const item of data.playbooks) {
    const parsed = PlaybookImport.safeParse(item);
    if (!parsed.success) { skipped++; continue; }
    const pb = parsed.data;
    const steps: PlaybookStep[] = pb.steps.map((s) => ({
      id: s.id ?? nanoid(8),
      commandId: s.commandId ?? null,
      inlineTemplate: s.inlineTemplate,
      connectionId: s.connectionId ? connMap[s.connectionId] ?? s.connectionId : undefined,
      values: s.values,
      continueOnError: s.continueOnError,
      captureAs: s.captureAs,
    }));
    playbooksRepo.upsert({
      id: pb.id,
      name: pb.name,
      description: pb.description,
      defaultConnectionId: pb.defaultConnectionId
        ? connMap[pb.defaultConnectionId] ?? pb.defaultConnectionId
        : undefined,
      steps,
      createdAt: pb.createdAt ?? ts,
      updatedAt: pb.updatedAt ?? ts,
    });
    nPb++;
  }

  return {
    mode,
    imported: { commands: nCmd, connections: nConn, playbooks: nPb, providers: nProv },
    secretsRestored,
    skipped,
  };
}

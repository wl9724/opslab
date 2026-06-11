import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ROOT_DIR } from '../config.js';
import {
  queryLogs,
  knownScopes,
  clearLogs,
  isDebugEnabled,
  setDebugEnabled,
  type LogLevel,
} from '../log.js';
import { activeRunCount } from '../executors/runner.js';
import { listSessionsInfo } from '../executors/terminalRegistry.js';

const SERVER_STARTED_AT = Date.now();

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const APP_VERSION = appVersion();

/** index.ts registers extras the routes layer can't reach (socket.io client count). */
let extraState: () => Record<string, unknown> = () => ({});
export function registerDebugStateProvider(fn: () => Record<string, unknown>): void {
  extraState = fn;
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const debugRouter = Router();

debugRouter.get('/logs', (req, res) => {
  const minLevel = LEVELS.includes(req.query.level as LogLevel) ? (req.query.level as LogLevel) : undefined;
  const result = queryLogs({
    minLevel,
    scope: typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
    afterId: req.query.afterId !== undefined ? Number(req.query.afterId) : undefined,
    limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
  });
  res.json({ ...result, scopes: knownScopes(), debugEnabled: isDebugEnabled() });
});

debugRouter.get('/state', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    version: APP_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
    uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    debugEnabled: isDebugEnabled(),
    activeRuns: activeRunCount(),
    termSessions: listSessionsInfo(),
    ...extraState(),
  });
});

const ConfigSchema = z.object({ enabled: z.boolean() });

debugRouter.post('/config', (req, res) => {
  const parsed = ConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  setDebugEnabled(parsed.data.enabled);
  res.json({ debugEnabled: isDebugEnabled() });
});

debugRouter.post('/clear', (_req, res) => {
  const cleared = clearLogs();
  res.json({ cleared });
});

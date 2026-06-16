import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PORT, HOST, ACCESS_TOKEN, APP_URL, ROOT_DIR } from './config.js';
import { commandsRouter } from './routes/commands.js';
import { connectionsRouter } from './routes/connections.js';
import { executionsRouter } from './routes/executions.js';
import { runRouter } from './routes/run.js';
import { aiRouter } from './routes/ai.js';
import { playbooksRouter } from './routes/playbooks.js';
import { backupRouter } from './routes/backup.js';
import { debugRouter, registerDebugStateProvider } from './routes/debug.js';
import { createLogger, onLog } from './log.js';
import { subscribe } from './executors/runner.js';
import { subscribePlaybook } from './executors/playbookRunner.js';
import {
  openSession,
  attachSession,
  detachSession,
  inputSession,
  resizeSession,
  closeSession,
  type TermSink,
} from './executors/terminalRegistry.js';
import { ensureLocalConnection, connectionsRepo } from './db.js';
import { seedIfEmpty } from './seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger('http');
const slog = createLogger('socket');

ensureLocalConnection();
seedIfEmpty();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '16mb' }));

// Request log. Skips /api/health and /api/debug/* — the 调试 page polls those and
// would otherwise flood the very buffer it is displaying.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path === '/api/health' || req.path.startsWith('/api/debug')) {
    return next();
  }
  const start = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level](`${req.method} ${req.path} → ${res.statusCode}`, { durationMs: Date.now() - start });
  });
  next();
});

app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!req.path.startsWith('/api/')) return next();
  const token = req.headers['x-opslab-token'] || req.query.token;
  if (token !== ACCESS_TOKEN) return res.status(401).json({ error: 'invalid token' });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/me', (_req, res) => res.json({ os: process.platform, shell: process.platform === 'win32' ? 'powershell' : 'bash' }));

app.use('/api/commands', commandsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/executions', executionsRouter);
app.use('/api/run', runRouter);
app.use('/api/ai', aiRouter);
app.use('/api/playbooks', playbooksRouter);
app.use('/api/backup', backupRouter);
app.use('/api/debug', debugRouter);

const clientDist = path.join(ROOT_DIR, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: true, credentials: true } });

io.use((socket, next) => {
  const t = socket.handshake.auth?.token ?? socket.handshake.query?.token;
  if (t !== ACCESS_TOKEN) return next(new Error('invalid token'));
  next();
});

registerDebugStateProvider(() => ({ socketClients: io.engine.clientsCount }));

io.on('connection', (socket) => {
  slog.debug('客户端连接', { socketId: socket.id, transport: socket.conn.transport.name });
  const unsubMap = new Map<string, () => void>();
  const playbookUnsubMap = new Map<string, () => void>();
  // Live debug-log stream for the 调试 page. One subscription per socket, idempotent.
  let debugLogUnsub: (() => void) | null = null;
  // Interactive terminal sessions this socket currently owns. The sessions themselves live in the
  // terminalRegistry (decoupled from the socket) so they survive a disconnect; here we just track
  // which ids to detach when this socket goes away.
  const attachedTerms = new Set<string>();
  const makeSink = (sessionId: string): TermSink => ({
    data: (data, seq) => socket.emit('term-data', { sessionId, data, seq }),
    exit: (exitCode) => socket.emit('term-exit', { sessionId, exitCode }),
  });

  socket.on('subscribe', (payload: { executionId: string }) => {
    if (!payload?.executionId) return;
    if (unsubMap.has(payload.executionId)) return;
    const unsub = subscribe(payload.executionId, (ev) => socket.emit('run-event', ev));
    unsubMap.set(payload.executionId, unsub);
  });
  socket.on('unsubscribe', (payload: { executionId: string }) => {
    const u = unsubMap.get(payload.executionId);
    if (u) {
      u();
      unsubMap.delete(payload.executionId);
    }
  });

  socket.on('subscribe-playbook', (payload: { playbookRunId: string }) => {
    if (!payload?.playbookRunId) return;
    if (playbookUnsubMap.has(payload.playbookRunId)) return;
    const unsub = subscribePlaybook(payload.playbookRunId, (ev) => socket.emit('playbook-event', ev));
    playbookUnsubMap.set(payload.playbookRunId, unsub);
  });
  socket.on('unsubscribe-playbook', (payload: { playbookRunId: string }) => {
    const u = playbookUnsubMap.get(payload.playbookRunId);
    if (u) {
      u();
      playbookUnsubMap.delete(payload.playbookRunId);
    }
  });

  socket.on('debug-subscribe', () => {
    if (debugLogUnsub) return;
    debugLogUnsub = onLog((entry) => socket.emit('debug-log', entry));
  });
  socket.on('debug-unsubscribe', () => {
    debugLogUnsub?.();
    debugLogUnsub = null;
  });

  // --- Interactive Web Terminal ---
  socket.on('term-open', async (payload: { sessionId: string; connectionId?: string; cols?: number; rows?: number }) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;

    const connection = payload.connectionId ? connectionsRepo.get(payload.connectionId) : ensureLocalConnection();
    if (!connection) {
      socket.emit('term-data', { sessionId, data: '\r\n\x1b[91m[opslab] connection not found\x1b[0m\r\n', seq: 0 });
      socket.emit('term-exit', { sessionId, exitCode: null });
      return;
    }

    attachedTerms.add(sessionId);
    await openSession(sessionId, connection, payload.cols ?? 80, payload.rows ?? 24, makeSink(sessionId), socket.id);
  });

  // Re-attach to a session that outlived a socket drop, replaying anything missed since `lastSeq`.
  socket.on('term-attach', (payload: { sessionId: string; lastSeq?: number; cols?: number; rows?: number }) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    const ok = attachSession(sessionId, makeSink(sessionId), socket.id, payload.lastSeq ?? 0, payload.cols ?? 0, payload.rows ?? 0);
    if (ok) {
      attachedTerms.add(sessionId);
      socket.emit('term-attached', { sessionId });
    } else {
      // Session is gone (server restarted, or its grace window expired) — client should start fresh.
      socket.emit('term-gone', { sessionId });
    }
  });

  socket.on('term-input', (payload: { sessionId: string; data: string }) => {
    inputSession(payload?.sessionId, payload?.data);
  });

  socket.on('term-resize', (payload: { sessionId: string; cols: number; rows: number }) => {
    resizeSession(payload?.sessionId, payload?.cols, payload?.rows);
  });

  socket.on('term-close', (payload: { sessionId: string }) => {
    if (!payload?.sessionId) return;
    attachedTerms.delete(payload.sessionId);
    closeSession(payload.sessionId);
  });

  socket.on('disconnect', (reason) => {
    slog.debug('客户端断开', { socketId: socket.id, reason });
    for (const u of unsubMap.values()) u();
    unsubMap.clear();
    for (const u of playbookUnsubMap.values()) u();
    playbookUnsubMap.clear();
    debugLogUnsub?.();
    debugLogUnsub = null;
    // Don't kill the PTYs — detach them so a reconnecting client can re-attach within the grace window.
    for (const id of attachedTerms) detachSession(id, socket.id);
    attachedTerms.clear();
  });
});

server.listen(PORT, HOST, () => {
  // Banner goes straight to console (it contains the access-token URL, which must
  // NOT enter the debug log buffer shown in the browser).
  createLogger('system').info('OpsLab 服务已启动', { host: HOST, port: PORT, node: process.version });
  console.log('');
  console.log('  OpsLab 0.1.1  (escape-strip=v2, bash=--norc --noprofile)');
  console.log(`  → ${APP_URL}`);
  if (!fs.existsSync(clientDist)) {
    console.log(`  → http://${HOST}:5173/?token=${ACCESS_TOKEN}   (Vite dev server)`);
  }
  console.log('');
  console.log('  Token is stored in data/access.token; subsequent visits cache it in localStorage.');
});

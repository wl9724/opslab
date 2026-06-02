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
import { subscribe } from './executors/runner.js';
import { subscribePlaybook } from './executors/playbookRunner.js';
import { openTerminal, type TermSession } from './executors/pty.js';
import { ensureLocalConnection, connectionsRepo } from './db.js';
import { seedIfEmpty } from './seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

ensureLocalConnection();
seedIfEmpty();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

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

io.on('connection', (socket) => {
  const unsubMap = new Map<string, () => void>();
  const playbookUnsubMap = new Map<string, () => void>();
  // Interactive terminal sessions, keyed by client-generated sessionId.
  // A pending marker reserves the slot during the async open so a fast term-close /
  // disconnect during connect can't leak the eventual PTY/SSH handle.
  const PENDING: TermSession = { write() {}, resize() {}, kill() {} };
  const termSessions = new Map<string, TermSession>();

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

  // --- Interactive Web Terminal ---
  socket.on('term-open', async (payload: { sessionId: string; connectionId?: string; cols?: number; rows?: number }) => {
    const sessionId = payload?.sessionId;
    if (!sessionId || termSessions.has(sessionId)) return;

    const connection = payload.connectionId ? connectionsRepo.get(payload.connectionId) : ensureLocalConnection();
    if (!connection) {
      socket.emit('term-data', { sessionId, data: '\r\n\x1b[91m[opslab] connection not found\x1b[0m\r\n' });
      socket.emit('term-exit', { sessionId, exitCode: null });
      return;
    }

    termSessions.set(sessionId, PENDING);
    const session = await openTerminal({
      connection,
      cols: payload.cols ?? 80,
      rows: payload.rows ?? 24,
      onData: (data) => socket.emit('term-data', { sessionId, data }),
      onExit: (exitCode) => {
        socket.emit('term-exit', { sessionId, exitCode });
        termSessions.delete(sessionId);
      },
      onError: (message) => socket.emit('term-data', { sessionId, data: `\r\n\x1b[91m[opslab] ${message}\x1b[0m\r\n` }),
    });

    // Client closed (or disconnected) while we were opening → tear the session down now.
    if (termSessions.get(sessionId) !== PENDING) {
      session.kill();
      return;
    }
    termSessions.set(sessionId, session);
  });

  socket.on('term-input', (payload: { sessionId: string; data: string }) => {
    termSessions.get(payload?.sessionId)?.write(payload.data);
  });

  socket.on('term-resize', (payload: { sessionId: string; cols: number; rows: number }) => {
    termSessions.get(payload?.sessionId)?.resize(payload.cols, payload.rows);
  });

  socket.on('term-close', (payload: { sessionId: string }) => {
    const s = termSessions.get(payload?.sessionId);
    if (!s) return;
    termSessions.delete(payload.sessionId);
    s.kill();
  });

  socket.on('disconnect', () => {
    for (const u of unsubMap.values()) u();
    unsubMap.clear();
    for (const u of playbookUnsubMap.values()) u();
    playbookUnsubMap.clear();
    for (const s of termSessions.values()) s.kill();
    termSessions.clear();
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  OpsLab 0.1.0  (escape-strip=v2, bash=--norc --noprofile)');
  console.log(`  → ${APP_URL}`);
  if (!fs.existsSync(clientDist)) {
    console.log(`  → http://${HOST}:5173/?token=${ACCESS_TOKEN}   (Vite dev server)`);
  }
  console.log('');
  console.log('  Token is stored in data/access.token; subsequent visits cache it in localStorage.');
});

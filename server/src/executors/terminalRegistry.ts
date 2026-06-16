import { openTerminal, type TermSession } from './pty.js';
import type { Connection } from '../types.js';
import { createLogger } from '../log.js';

const log = createLogger('term');

/**
 * Registry of live interactive terminal sessions, decoupled from any single socket.
 *
 * The one-shot runner streams read-only output, but a Web Terminal is a real PTY the user is
 * mid-task in. If we tore the PTY down the instant its socket dropped (a wifi blip, a laptop
 * sleep, a proxy idle timeout, `tsx watch` restarting the dev server), a long-running job would
 * die and the screen would reset. Instead the PTY is owned here, keyed by the client-minted
 * sessionId, and survives a disconnect for a grace window so a reconnecting client can re-attach.
 *
 * Re-attach is gap-free: every byte of output advances a monotonic `seq` (cumulative length) and
 * is kept in a bounded ring buffer. On attach the client reports the last seq it saw and we replay
 * only what it missed — its existing xterm scrollback stays intact instead of being repainted.
 *
 * Single-user, localhost + token only, so a random unguessable sessionId is sufficient authority
 * to re-attach; there is no per-session owner check beyond the socket-level token gate.
 */

export interface TermSink {
  /** Deliver output to the attached client. `seq` is the cumulative output length at its end. */
  data(data: string, seq: number): void;
  /** The PTY exited (or failed to start). */
  exit(exitCode: number | null): void;
}

/** How long a detached session keeps running before we give up and kill it. */
const GRACE_MS = Math.max(0, Number(process.env.OPSLAB_TERM_GRACE_MS ?? 120_000));
/** Cap on retained output (in JS string length) available for replay on re-attach. */
const BUFFER_CAP = Math.max(4096, Number(process.env.OPSLAB_TERM_BUFFER_BYTES ?? 256 * 1024));

interface Chunk {
  /** Cumulative output length at the end of this chunk — its upper `seq` bound. */
  end: number;
  data: string;
}

interface Entry {
  id: string;
  session: TermSession;
  cols: number;
  rows: number;
  /** Recent output, oldest first; total length is kept under BUFFER_CAP. */
  chunks: Chunk[];
  /** Cumulative length of all output ever produced — the seq space. */
  total: number;
  /** Sum of `chunks` lengths currently retained. */
  buffered: number;
  /** seq of the first still-retained byte (== total - buffered). */
  oldest: number;
  /** Whether any output has been evicted from the buffer (so replay can warn). */
  dropped: boolean;
  exited: boolean;
  exitCode: number | null;
  /** Id of the socket that currently owns the session (null while detached). */
  tag: string | null;
  sink: TermSink | null;
  grace?: ReturnType<typeof setTimeout>;
}

/** Placeholder while `openTerminal` is awaited, so a close/disconnect mid-open can't leak a PTY. */
const PENDING: TermSession = { write() {}, resize() {}, kill() {} };

const sessions = new Map<string, Entry>();

function appendOutput(e: Entry, data: string): void {
  if (!data) return;
  e.total += data.length;
  e.chunks.push({ end: e.total, data });
  e.buffered += data.length;
  // Evict oldest chunks past the cap, but always keep at least one (a single chunk may exceed it).
  while (e.buffered > BUFFER_CAP && e.chunks.length > 1) {
    const c = e.chunks.shift()!;
    e.buffered -= c.data.length;
    e.dropped = true;
  }
  e.oldest = e.total - e.buffered;
  e.sink?.data(data, e.total);
}

function markExit(e: Entry, code: number | null): void {
  e.exited = true;
  e.exitCode = code;
  log.info('终端会话退出', { sessionId: e.id, exitCode: code });
  e.sink?.exit(code);
}

/** Open a brand-new session and register it. Output is buffered + forwarded to `sink`. */
export async function openSession(
  sessionId: string,
  connection: Connection,
  cols: number,
  rows: number,
  sink: TermSink,
  tag: string,
): Promise<void> {
  if (sessions.has(sessionId)) {
    // Duplicate id (shouldn't happen) — re-attach instead so we never orphan the existing PTY.
    attachSession(sessionId, sink, tag, 0, cols, rows);
    return;
  }

  const e: Entry = {
    id: sessionId,
    session: PENDING,
    cols,
    rows,
    chunks: [],
    total: 0,
    buffered: 0,
    oldest: 0,
    dropped: false,
    exited: false,
    exitCode: null,
    tag,
    sink,
  };
  sessions.set(sessionId, e);
  log.info('终端会话打开', {
    sessionId,
    connection: `${connection.name} (${connection.type})`,
    size: `${cols}x${rows}`,
  });

  const session = await openTerminal({
    connection,
    cols,
    rows,
    onData: (d) => appendOutput(e, d),
    onExit: (code) => markExit(e, code),
    onError: (m) => appendOutput(e, `\r\n\x1b[91m[opslab] ${m}\x1b[0m\r\n`),
  });

  // The session may have been closed (entry removed) or replaced while we awaited the async open.
  // If the slot no longer holds this entry, the live handle is orphaned — kill it now.
  if (sessions.get(sessionId) !== e) {
    session.kill();
    return;
  }
  e.session = session;
  // A resize may have arrived during the open; apply the latest known size.
  session.resize(e.cols, e.rows);
}

/**
 * Re-bind an existing session to a (re)connected socket and replay anything it missed since
 * `lastSeq`. Returns false if the session no longer exists (caller should tell the client it's gone).
 */
export function attachSession(
  sessionId: string,
  sink: TermSink,
  tag: string,
  lastSeq: number,
  cols: number,
  rows: number,
): boolean {
  const e = sessions.get(sessionId);
  if (!e) {
    log.debug('终端重连失败：会话不存在', { sessionId, lastSeq });
    return false;
  }

  log.debug('终端会话重连', { sessionId, lastSeq, total: e.total });
  if (e.grace) {
    clearTimeout(e.grace);
    e.grace = undefined;
  }
  e.tag = tag;
  e.sink = sink;
  if (cols > 0 && rows > 0) {
    e.cols = cols;
    e.rows = rows;
    e.session.resize(cols, rows);
  }

  replay(e, sink, lastSeq);
  if (e.exited) sink.exit(e.exitCode);
  return true;
}

function replay(e: Entry, sink: TermSink, lastSeq: number): void {
  if (lastSeq >= e.total) return; // client already has everything
  if (lastSeq < e.oldest) {
    // The gap between what the client had and what we still hold was evicted from the buffer.
    sink.data('\r\n\x1b[90m[opslab] 部分历史输出超出缓冲，未能恢复\x1b[0m\r\n', e.oldest);
    for (const c of e.chunks) sink.data(c.data, c.end);
    return;
  }
  for (const c of e.chunks) {
    if (c.end <= lastSeq) continue;
    const start = c.end - c.data.length;
    // Slice the boundary chunk so the client doesn't re-render bytes it already had.
    sink.data(start < lastSeq ? c.data.slice(lastSeq - start) : c.data, c.end);
  }
}

/** The owning socket dropped: keep the PTY running for the grace window, then reap it. */
export function detachSession(sessionId: string, tag: string): void {
  const e = sessions.get(sessionId);
  if (!e || e.tag !== tag) return; // already gone, or a newer socket took ownership
  e.tag = null;
  e.sink = null;
  if (e.grace) clearTimeout(e.grace);
  if (GRACE_MS === 0) {
    closeSession(sessionId);
    return;
  }
  log.debug('终端会话挂起，等待重连', { sessionId, graceMs: GRACE_MS });
  e.grace = setTimeout(() => {
    log.info('终端会话保活超时，销毁', { sessionId });
    closeSession(sessionId);
  }, GRACE_MS);
}

export function inputSession(sessionId: string, data: string): void {
  sessions.get(sessionId)?.session.write(data);
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  const e = sessions.get(sessionId);
  if (!e) return;
  e.cols = cols;
  e.rows = rows;
  e.session.resize(cols, rows);
}

/** Permanently end a session (user closed the tab, or its grace window expired). */
export function closeSession(sessionId: string): void {
  const e = sessions.get(sessionId);
  if (!e) return;
  if (e.grace) clearTimeout(e.grace);
  sessions.delete(sessionId);
  log.debug('终端会话关闭', { sessionId });
  try {
    e.session.kill();
  } catch {
    /* swallow */
  }
}

/** Snapshot of live sessions for the debug state panel. */
export function listSessionsInfo(): Array<{
  id: string;
  size: string;
  attached: boolean;
  exited: boolean;
  bufferedBytes: number;
}> {
  return [...sessions.values()].map((e) => ({
    id: e.id,
    size: `${e.cols}x${e.rows}`,
    attached: e.sink !== null,
    exited: e.exited,
    bufferedBytes: e.buffered,
  }));
}

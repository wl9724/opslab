import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

function getToken(): string {
  return localStorage.getItem('opslab.token') ?? '';
}

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({
    path: '/socket.io',
    auth: { token: getToken() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });
  socket.on('connect_error', (err) => {
    console.warn('[opslab] socket connect_error:', err.message);
  });
  return socket;
}

export type RunEvent =
  | { type: 'chunk'; executionId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'done'; executionId: string; status: string; exitCode: number | null };

export function subscribeRun(
  executionId: string,
  onEvent: (ev: RunEvent) => void,
): () => void {
  const s = getSocket();
  const handler = (ev: RunEvent) => {
    if (ev.executionId === executionId) onEvent(ev);
  };
  s.on('run-event', handler);
  s.emit('subscribe', { executionId });
  return () => {
    s.emit('unsubscribe', { executionId });
    s.off('run-event', handler);
  };
}

export type TermStatus = 'connecting' | 'connected' | 'reconnecting';

export interface TerminalController {
  /** Send keystrokes / pasted text to the remote PTY. */
  input: (data: string) => void;
  /** Tell the remote PTY the viewport changed. */
  resize: (cols: number, rows: number) => void;
  /** Close the session and stop listening. */
  close: () => void;
}

/**
 * Open an interactive terminal session over the socket. The client mints the sessionId so it
 * can wire its listeners before the server confirms — incoming term-* events are filtered by id.
 *
 * The server keeps the PTY alive across a socket drop, so a disconnect is NOT an exit: it becomes
 * a `reconnecting` state, and once socket.io reconnects we re-attach by sessionId and the server
 * replays whatever output we missed (tracked by `lastSeq`). If the session is truly gone (server
 * restarted, or its grace window expired) the server replies `term-gone` and we call `onLost` so
 * the caller can open a fresh session.
 */
export function openTerminal(args: {
  connectionId?: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
  /** Connecting / connected / reconnecting transitions (the real PTY exit comes via onExit). */
  onStatus?: (status: TermStatus) => void;
  /** The server lost the session after a drop; the caller should open a fresh one. */
  onLost?: () => void;
}): TerminalController {
  const s = getSocket();
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let closed = false;
  let opened = false;
  let lastSeq = 0;
  let cols = args.cols;
  let rows = args.rows;

  const onData = (ev: { sessionId: string; data: string; seq?: number }) => {
    if (ev.sessionId !== sessionId) return;
    if (typeof ev.seq === 'number') lastSeq = ev.seq;
    if (!closed) args.onStatus?.('connected');
    args.onData(ev.data);
  };
  const finishOnce = (exitCode: number | null) => {
    if (closed) return;
    closed = true;
    teardown();
    args.onExit(exitCode);
  };
  const onExit = (ev: { sessionId: string; exitCode: number | null }) => {
    if (ev.sessionId === sessionId) finishOnce(ev.exitCode);
  };
  const onAttached = (ev: { sessionId: string }) => {
    if (ev.sessionId === sessionId && !closed) args.onStatus?.('connected');
  };
  const onGone = (ev: { sessionId: string }) => {
    if (ev.sessionId === sessionId && !closed) args.onLost?.();
  };

  // Fires on the initial connect and on every reconnect. First time → open; afterwards → re-attach.
  const onConnect = () => {
    if (closed) return;
    if (!opened) {
      opened = true;
      s.emit('term-open', { sessionId, connectionId: args.connectionId, cols, rows });
    } else {
      args.onStatus?.('reconnecting');
      s.emit('term-attach', { sessionId, lastSeq, cols, rows });
    }
  };
  const onDisconnect = () => { if (!closed) args.onStatus?.('reconnecting'); };

  function teardown() {
    s.off('term-data', onData);
    s.off('term-exit', onExit);
    s.off('term-attached', onAttached);
    s.off('term-gone', onGone);
    s.off('connect', onConnect);
    s.off('disconnect', onDisconnect);
  }

  s.on('term-data', onData);
  s.on('term-exit', onExit);
  s.on('term-attached', onAttached);
  s.on('term-gone', onGone);
  s.on('connect', onConnect);
  s.on('disconnect', onDisconnect);

  args.onStatus?.('connecting');
  // If the socket is already up, open now; otherwise onConnect will fire and do it.
  if (s.connected) {
    opened = true;
    s.emit('term-open', { sessionId, connectionId: args.connectionId, cols, rows });
  }

  return {
    input: (data) => { if (!closed) s.emit('term-input', { sessionId, data }); },
    resize: (c, r) => {
      cols = c;
      rows = r;
      if (!closed) s.emit('term-resize', { sessionId, cols: c, rows: r });
    },
    close: () => {
      if (closed) return;
      closed = true;
      s.emit('term-close', { sessionId });
      teardown();
    },
  };
}

import type { PlaybookEvent } from './types';

export function subscribePlaybook(
  playbookRunId: string,
  onEvent: (ev: PlaybookEvent) => void,
): () => void {
  const s = getSocket();
  const handler = (ev: PlaybookEvent) => {
    if (ev.playbookRunId === playbookRunId) onEvent(ev);
  };
  s.on('playbook-event', handler);
  s.emit('subscribe-playbook', { playbookRunId });
  return () => {
    s.emit('unsubscribe-playbook', { playbookRunId });
    s.off('playbook-event', handler);
  };
}

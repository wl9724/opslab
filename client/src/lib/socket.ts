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
 * can wire its listeners before the server confirms — incoming term-data/term-exit are filtered
 * by that id. Returns a controller for input/resize/close.
 */
export function openTerminal(args: {
  connectionId?: string;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}): TerminalController {
  const s = getSocket();
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let closed = false;

  const onData = (ev: { sessionId: string; data: string }) => {
    if (ev.sessionId === sessionId) args.onData(ev.data);
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
  // A socket drop (e.g. server restart under `tsx watch`) kills the server-side PTY, so the
  // session is gone — surface it as an exit rather than leaving the UI falsely "connected".
  const onDisconnect = () => finishOnce(null);

  function teardown() {
    s.off('term-data', onData);
    s.off('term-exit', onExit);
    s.off('disconnect', onDisconnect);
  }

  s.on('term-data', onData);
  s.on('term-exit', onExit);
  s.on('disconnect', onDisconnect);
  s.emit('term-open', { sessionId, connectionId: args.connectionId, cols: args.cols, rows: args.rows });

  return {
    input: (data) => { if (!closed) s.emit('term-input', { sessionId, data }); },
    resize: (cols, rows) => { if (!closed) s.emit('term-resize', { sessionId, cols, rows }); },
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

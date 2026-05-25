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

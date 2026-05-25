import type { AIProvider, AIChatRequest } from '../types.js';

export type StreamChunk = { type: 'text'; delta: string } | { type: 'error'; message: string } | { type: 'done' };

export interface ChatProvider {
  stream(provider: AIProvider, req: AIChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

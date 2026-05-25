import type { ChatProvider, StreamChunk } from './base.js';
import { buildSystemPrompt } from './prompts.js';

export const ollamaProvider: ChatProvider = {
  async *stream(provider, req, signal): AsyncIterable<StreamChunk> {
    const base = provider.baseUrl || 'http://127.0.0.1:11434';
    const url = `${base.replace(/\/$/, '')}/api/chat`;
    const messages = [
      { role: 'system', content: buildSystemPrompt(req.context) },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: provider.model, messages, stream: true }),
        signal,
      });
    } catch (e) {
      yield { type: 'error', message: `Failed to reach Ollama at ${base}: ${(e as Error).message}` };
      yield { type: 'done' };
      return;
    }

    if (!res.ok || !res.body) {
      yield { type: 'error', message: `Ollama HTTP ${res.status}` };
      yield { type: 'done' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const delta = obj?.message?.content;
            if (delta) yield { type: 'text', delta };
            if (obj?.done) {
              yield { type: 'done' };
              return;
            }
          } catch {
            /* swallow malformed line */
          }
        }
      }
      yield { type: 'done' };
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      yield { type: 'done' };
    }
  },
};

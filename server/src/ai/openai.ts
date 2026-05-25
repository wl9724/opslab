import OpenAI from 'openai';
import type { ChatProvider, StreamChunk } from './base.js';
import { getSecret } from '../secrets.js';
import { buildSystemPrompt } from './prompts.js';

export const openaiProvider: ChatProvider = {
  async *stream(provider, req, signal): AsyncIterable<StreamChunk> {
    const apiKey = provider.secretRef ? getSecret(provider.secretRef) : undefined;
    if (!apiKey) {
      yield { type: 'error', message: 'API key not configured for OpenAI-compatible provider' };
      yield { type: 'done' };
      return;
    }
    const client = new OpenAI({
      apiKey,
      baseURL: provider.baseUrl || undefined,
    });

    const messages = [
      { role: 'system' as const, content: buildSystemPrompt(req.context) },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    try {
      const stream = await client.chat.completions.create(
        {
          model: provider.model,
          messages,
          stream: true,
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield { type: 'text', delta };
      }
      yield { type: 'done' };
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      yield { type: 'done' };
    }
  },
};

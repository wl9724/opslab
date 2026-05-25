import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, StreamChunk } from './base.js';
import { getSecret } from '../secrets.js';
import { buildSystemPrompt } from './prompts.js';

export const claudeProvider: ChatProvider = {
  async *stream(provider, req, signal): AsyncIterable<StreamChunk> {
    const apiKey = provider.secretRef ? getSecret(provider.secretRef) : undefined;
    if (!apiKey) {
      yield { type: 'error', message: 'Claude API key not configured' };
      yield { type: 'done' };
      return;
    }
    const client = new Anthropic({
      apiKey,
      baseURL: provider.baseUrl || undefined,
    });

    const systemMsgs = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const convo = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const system = [buildSystemPrompt(req.context), ...systemMsgs].join('\n\n');

    try {
      const stream = client.messages.stream(
        {
          model: provider.model,
          system,
          messages: convo,
          max_tokens: 2048,
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        }
      }
      yield { type: 'done' };
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      yield { type: 'done' };
    }
  },
};

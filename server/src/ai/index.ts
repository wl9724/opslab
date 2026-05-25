import type { ChatProvider } from './base.js';
import type { AIProviderType } from '../types.js';
import { claudeProvider } from './claude.js';
import { openaiProvider } from './openai.js';
import { ollamaProvider } from './ollama.js';

const REGISTRY: Record<AIProviderType, ChatProvider> = {
  claude: claudeProvider,
  openai: openaiProvider,
  ollama: ollamaProvider,
};

export function getChatProvider(type: AIProviderType): ChatProvider {
  return REGISTRY[type];
}

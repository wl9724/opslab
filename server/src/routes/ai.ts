import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { providersRepo } from '../db.js';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../secrets.js';
import { getChatProvider } from '../ai/index.js';
import { createLogger } from '../log.js';

const log = createLogger('ai');

const ProviderInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['claude', 'openai', 'ollama']),
  baseUrl: z.string().optional(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

const ChatRequestSchema = z.object({
  providerId: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ),
  context: z
    .object({
      os: z.string().optional(),
      shell: z.string().optional(),
      targetType: z.enum(['local', 'ssh', 'docker', 'k8s']).optional(),
      connectionName: z.string().optional(),
      currentCommand: z.string().optional(),
    })
    .optional(),
});

export const aiRouter = Router();

aiRouter.get('/providers', (_req, res) => {
  const list = providersRepo.list().map((p) => ({
    ...p,
    hasKey: p.secretRef ? hasSecret(p.secretRef) : false,
    secretRef: undefined,
  }));
  res.json(list);
});

aiRouter.post('/providers', (req, res) => {
  const parsed = ProviderInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { apiKey, ...rest } = parsed.data;
  let secretRef: string | undefined;
  if (apiKey) {
    secretRef = `ai:${nanoid(10)}`;
    setSecret(secretRef, apiKey);
  }
  const created = providersRepo.create({ ...rest, secretRef });
  res.status(201).json({ ...created, hasKey: !!secretRef, secretRef: undefined });
});

aiRouter.put('/providers/:id', (req, res) => {
  const parsed = ProviderInputSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const cur = providersRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const { apiKey, ...patch } = parsed.data;
  let secretRef = cur.secretRef;
  if (apiKey !== undefined) {
    if (apiKey === '') {
      if (secretRef) deleteSecret(secretRef);
      secretRef = undefined;
    } else {
      if (!secretRef) secretRef = `ai:${nanoid(10)}`;
      setSecret(secretRef, apiKey);
    }
  }
  const updated = providersRepo.update(req.params.id, { ...patch, secretRef });
  res.json({ ...updated, hasKey: !!secretRef, secretRef: undefined });
});

aiRouter.delete('/providers/:id', (req, res) => {
  const cur = providersRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.secretRef) deleteSecret(cur.secretRef);
  providersRepo.delete(req.params.id);
  res.status(204).end();
});

aiRouter.post('/chat', async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { providerId, messages, context } = parsed.data;

  const provider = providerId ? providersRepo.get(providerId) : providersRepo.getDefault();
  if (!provider) return res.status(404).json({ error: 'no AI provider configured' });
  if (!provider.enabled) return res.status(400).json({ error: 'provider is disabled' });

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // Log metadata only — message content may hold hosts/keys the user pasted.
  log.info('AI 对话请求', {
    provider: provider.name,
    type: provider.type,
    model: provider.model,
    messages: messages.length,
  });
  const startedAt = Date.now();

  const impl = getChatProvider(provider.type);
  try {
    for await (const chunk of impl.stream(provider, { providerId: provider.id, messages, context }, controller.signal)) {
      if (chunk.type === 'error') {
        log.warn('AI 返回错误', { provider: provider.name, error: chunk.message });
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (chunk.type === 'done') break;
    }
    log.debug('AI 对话完成', { provider: provider.name, durationMs: Date.now() - startedAt });
  } catch (e) {
    log.error('AI 流式调用异常', { provider: provider.name, error: (e as Error).message });
    res.write(`data: ${JSON.stringify({ type: 'error', message: (e as Error).message })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  }
  res.end();
});

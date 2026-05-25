import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { connectionsRepo } from '../db.js';
import { setSecret, deleteSecret } from '../secrets.js';
import { testSsh } from '../executors/ssh.js';

const ConnectionInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['local', 'ssh']),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  authType: z.enum(['password', 'privateKey']).optional(),
  secret: z.string().optional(),
});

export const connectionsRouter = Router();

connectionsRouter.get('/', (_req, res) => {
  res.json(connectionsRepo.list());
});

connectionsRouter.post('/', (req, res) => {
  const parsed = ConnectionInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { secret, ...input } = parsed.data;
  let secretRef: string | undefined;
  if (secret) {
    secretRef = `conn:${nanoid(10)}`;
    setSecret(secretRef, secret);
  }
  res.status(201).json(connectionsRepo.create({ ...input, secretRef }));
});

connectionsRouter.put('/:id', (req, res) => {
  const parsed = ConnectionInputSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const cur = connectionsRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const { secret, ...patch } = parsed.data;
  let secretRef = cur.secretRef;
  if (secret !== undefined) {
    if (secret === '') {
      if (secretRef) deleteSecret(secretRef);
      secretRef = undefined;
    } else {
      if (!secretRef) secretRef = `conn:${nanoid(10)}`;
      setSecret(secretRef, secret);
    }
  }
  const updated = connectionsRepo.update(req.params.id, { ...patch, secretRef });
  res.json(updated);
});

connectionsRouter.delete('/:id', (req, res) => {
  const cur = connectionsRepo.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.secretRef) deleteSecret(cur.secretRef);
  connectionsRepo.delete(req.params.id);
  res.status(204).end();
});

connectionsRouter.post('/:id/test', async (req, res) => {
  const conn = connectionsRepo.get(req.params.id);
  if (!conn) return res.status(404).json({ error: 'not found' });
  if (conn.type === 'local') return res.json({ ok: true, message: 'Local connection always ready' });
  const result = await testSsh(conn);
  res.json(result);
});

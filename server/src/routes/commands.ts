import { Router } from 'express';
import { z } from 'zod';
import { commandsRepo } from '../db.js';

const VarSchema = z.object({
  name: z.string().min(1),
  label: z.string().default(''),
  type: z.enum(['text', 'number', 'select', 'boolean']),
  defaultValue: z.string().optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean().default(false),
});

const CommandInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  template: z.string().min(1),
  targetType: z.enum(['local', 'ssh', 'docker', 'k8s']),
  interpreter: z.string().default('auto'),
  vars: z.array(VarSchema).default([]),
  tags: z.array(z.string()).default([]),
  favorite: z.boolean().default(false),
});

export const commandsRouter = Router();

commandsRouter.get('/', (_req, res) => {
  res.json(commandsRepo.list());
});

commandsRouter.get('/:id', (req, res) => {
  const cmd = commandsRepo.get(req.params.id);
  if (!cmd) return res.status(404).json({ error: 'not found' });
  res.json(cmd);
});

commandsRouter.post('/', (req, res) => {
  const parsed = CommandInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(commandsRepo.create(parsed.data));
});

commandsRouter.put('/:id', (req, res) => {
  const parsed = CommandInputSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = commandsRepo.update(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

commandsRouter.delete('/:id', (req, res) => {
  const ok = commandsRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

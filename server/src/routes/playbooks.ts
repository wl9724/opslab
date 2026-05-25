import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { playbooksRepo } from '../db.js';
import { startPlaybook, abortPlaybook, getPlaybookRun } from '../executors/playbookRunner.js';
import { RunnerError } from '../executors/runner.js';

const StepSchema = z.object({
  id: z.string().optional(),
  commandId: z.string().nullable(),
  inlineTemplate: z.string().optional(),
  connectionId: z.string().optional(),
  values: z.record(z.string()).optional(),
  continueOnError: z.boolean().default(false),
  captureAs: z.string().optional(),
}).transform((s) => ({ ...s, id: s.id ?? nanoid(8) }));

const PlaybookInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  defaultConnectionId: z.string().optional(),
  steps: z.array(StepSchema).default([]),
});

const RunInputSchema = z.object({
  playbookId: z.string().optional(),
  inline: z
    .object({
      name: z.string().default('(inline)'),
      description: z.string().default(''),
      defaultConnectionId: z.string().optional(),
      steps: z.array(StepSchema),
    })
    .optional(),
  initialValues: z.record(z.string()).optional(),
  confirmDanger: z.boolean().optional(),
});

export const playbooksRouter = Router();

playbooksRouter.get('/', (_req, res) => {
  res.json(playbooksRepo.list());
});

playbooksRouter.get('/:id', (req, res) => {
  const p = playbooksRepo.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

playbooksRouter.post('/', (req, res) => {
  const parsed = PlaybookInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(playbooksRepo.create(parsed.data));
});

playbooksRouter.put('/:id', (req, res) => {
  const parsed = PlaybookInputSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const updated = playbooksRepo.update(req.params.id, parsed.data);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

playbooksRouter.delete('/:id', (req, res) => {
  const ok = playbooksRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

playbooksRouter.post('/run', (req, res) => {
  const parsed = RunInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = startPlaybook(parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof RunnerError) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: (e as Error).message });
  }
});

playbooksRouter.get('/run/:id', (req, res) => {
  const r = getPlaybookRun(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

playbooksRouter.post('/run/:id/abort', (req, res) => {
  const ok = abortPlaybook(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

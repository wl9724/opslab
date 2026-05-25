import { Router } from 'express';
import { z } from 'zod';
import { startRun, stopRun, RunnerError } from '../executors/runner.js';

const RunInputSchema = z.object({
  commandId: z.string().optional(),
  connectionId: z.string().optional(),
  template: z.string().optional(),
  interpreter: z.string().optional(),
  values: z.record(z.string()).optional(),
  confirmDanger: z.boolean().optional(),
});

const FanoutInputSchema = z.object({
  commandId: z.string().optional(),
  template: z.string().optional(),
  interpreter: z.string().optional(),
  connectionIds: z.array(z.string()).min(1),
  values: z.record(z.string()).optional(),
  confirmDanger: z.boolean().optional(),
});

export const runRouter = Router();

runRouter.post('/', (req, res) => {
  const parsed = RunInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = startRun(parsed.data);
    res.json(result);
  } catch (e) {
    if (e instanceof RunnerError) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: (e as Error).message });
  }
});

runRouter.post('/fanout', (req, res) => {
  const parsed = FanoutInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { connectionIds, ...rest } = parsed.data;
  const results = connectionIds.map((connectionId) => {
    try {
      const r = startRun({ ...rest, connectionId });
      return { connectionId, ok: true as const, execution: r.execution, safety: r.safety };
    } catch (e) {
      return {
        connectionId,
        ok: false as const,
        error: e instanceof RunnerError ? e.message : (e as Error).message,
      };
    }
  });
  res.json({ results });
});

runRouter.post('/:id/stop', (req, res) => {
  const ok = stopRun(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not running' });
  res.json({ ok: true });
});

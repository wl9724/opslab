import { Router } from 'express';
import { executionsRepo } from '../db.js';
import { readOutput } from '../executors/runner.js';

export const executionsRouter = Router();

executionsRouter.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const commandId = typeof req.query.commandId === 'string' ? req.query.commandId : undefined;
  res.json(executionsRepo.list(limit, commandId));
});

executionsRouter.get('/:id', (req, res) => {
  const ex = executionsRepo.get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const output = readOutput(req.params.id);
  res.json({ ...ex, output });
});

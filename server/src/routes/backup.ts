import { Router } from 'express';
import { z } from 'zod';
import { exportBackup, importBackup } from '../backup.js';

export const backupRouter = Router();

backupRouter.get('/export', (req, res) => {
  const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true';
  res.json(exportBackup(includeSecrets));
});

const ImportBodySchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  data: z.unknown(),
});

backupRouter.post('/import', (req, res) => {
  const parsed = ImportBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    res.json(importBackup(parsed.data.data, parsed.data.mode));
  } catch (e) {
    res.status(400).json({ error: '无法解析备份文件：' + (e as Error).message });
  }
});

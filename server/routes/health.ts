import { Router } from 'express';
import { getDatabaseStatus } from '../config/db.ts';
import { getLastLeadIntegritySummary } from '../utils/leadIntegrity.ts';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'outreach-desk',
    database: getDatabaseStatus(),
    leadIntegrity: getLastLeadIntegritySummary(),
    timestamp: new Date().toISOString(),
  });
});

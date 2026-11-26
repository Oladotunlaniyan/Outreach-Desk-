import { Router } from 'express';
import { connectDatabase, getDatabaseStatus } from '../config/db.ts';
import {
  getEnvConfig,
  getProductionReadinessReport,
  getPublicMailboxSummaries,
} from '../config/env.ts';
import { requireAuth } from '../middleware/auth.ts';
import { getMailboxEncryptionStatus } from '../utils/mailboxCrypto.ts';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get('/overview', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const env = getEnvConfig();
  const db = getDatabaseStatus();
  const mailboxes = getPublicMailboxSummaries();

  res.json({
    database: db,
    auth: {
      accessCodeConfigured: Boolean(env.accessCode),
      jwtSecretConfigured: env.hasPersistentJwtSecret,
    },
    geminiConfigured: Boolean(env.geminiApiKey),
    deepseek: {
      configured: Boolean(env.deepseekApiKey),
      model: env.deepseekModel,
      baseUrl: env.deepseekBaseUrl,
    },
    mailboxEncryption: getMailboxEncryptionStatus(),
    productionReadiness: getProductionReadinessReport(),
    mailboxes,
  });
});

settingsRouter.post('/database/reconnect', async (_req, res) => {
  const connected = await connectDatabase();
  const db = getDatabaseStatus();
  res.status(connected ? 200 : 503).json({
    connected,
    database: db,
    ...(connected ? {} : { error: db.lastError || 'Failed to connect to MongoDB Atlas.' }),
  });
});

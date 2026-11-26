import express, { type Express } from 'express';
import { connectDatabase, getDatabaseStatus } from './config/db.ts';
import { aiRouter } from './routes/ai.ts';
import { authRouter } from './routes/auth.ts';
import { bouncesRouter } from './routes/bounces.ts';
import { campaignsRouter } from './routes/campaigns.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { emailsRouter } from './routes/emails.ts';
import { healthRouter } from './routes/health.ts';
import { leadsRouter } from './routes/leads.ts';
import { mailboxesRouter } from './routes/mailboxes.ts';
import { researchRouter } from './routes/research.ts';
import { senderProfileRouter } from './routes/senderProfile.ts';
import { settingsRouter } from './routes/settings.ts';
import { suppressionsRouter } from './routes/suppressions.ts';
import { unsubscribeRouter } from './routes/unsubscribe.ts';

export interface CreateApiAppOptions {
  ensureDbOnRequest?: boolean;
}

export function createApiApp(options: CreateApiAppOptions = {}): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

  if (options.ensureDbOnRequest) {
    app.use('/api', async (req, _res, next) => {
      if (req.path === '/health') {
        next();
        return;
      }
      const db = getDatabaseStatus();
      if (db.configured && !db.connected) {
        await connectDatabase();
      }
      next();
    });
  }

  app.use('/api/health', healthRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/bounces', bouncesRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/emails', emailsRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/mailboxes', mailboxesRouter);
  app.use('/api/research', researchRouter);
  app.use('/api/sender-profile', senderProfileRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/suppressions', suppressionsRouter);
  app.use('/api/unsubscribe', unsubscribeRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.', code: 'NOT_FOUND' });
  });

  return app;
}

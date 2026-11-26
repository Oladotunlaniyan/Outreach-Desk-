import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { connectDatabase } from './server/config/db.ts';
import { getEnvConfig, getProductionReadinessReport } from './server/config/env.ts';
import { logEvent } from './server/utils/logger.ts';
import { aiRouter } from './server/routes/ai.ts';
import { authRouter } from './server/routes/auth.ts';
import { bouncesRouter } from './server/routes/bounces.ts';
import { campaignsRouter } from './server/routes/campaigns.ts';
import { dashboardRouter } from './server/routes/dashboard.ts';
import { emailsRouter } from './server/routes/emails.ts';
import { healthRouter } from './server/routes/health.ts';
import { leadsRouter } from './server/routes/leads.ts';
import { mailboxesRouter } from './server/routes/mailboxes.ts';
import { senderProfileRouter } from './server/routes/senderProfile.ts';
import { settingsRouter } from './server/routes/settings.ts';
import { suppressionsRouter } from './server/routes/suppressions.ts';
import { unsubscribeRouter } from './server/routes/unsubscribe.ts';
import { researchRouter } from './server/routes/research.ts';
import { recoverInterruptedCampaigns } from './server/utils/campaignWorker.ts';
import { recoverInterruptedResearchJobs } from './server/utils/leadResearcher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function bootstrap() {
  const env = getEnvConfig();
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

  if (env.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(env.port, '0.0.0.0', () => {
    const readiness = getProductionReadinessReport();
    logEvent('info', 'server.listening', {
      port: env.port,
      nodeEnv: env.nodeEnv,
      readyForProduction: readiness.readyForProduction,
      incompleteChecks: readiness.checks.filter((c) => !c.ok).map((c) => c.key),
    });
    if (env.nodeEnv === 'production' && !readiness.readyForProduction) {
      logEvent('error', 'server.production_config_incomplete', {
        missingRequiredChecks: readiness.checks
          .filter((c) => c.severity === 'required' && !c.ok)
          .map((c) => c.key),
      });
    }
    void connectDatabase().then(async (connected) => {
      if (connected) {
        const [recoveredCampaigns, recoveredResearch] = await Promise.all([
          recoverInterruptedCampaigns(),
          recoverInterruptedResearchJobs(),
        ]);
        if (recoveredCampaigns > 0) {
          logEvent('info', 'worker.startup_recovered', { recoveredCount: recoveredCampaigns });
        }
        if (recoveredResearch > 0) {
          logEvent('info', 'research.startup_recovered', { recoveredCount: recoveredResearch });
        }
      }
    });
  });
}

bootstrap().catch((err) => {
  logEvent('error', 'server.fatal_startup_error', { error: err });
  process.exit(1);
});

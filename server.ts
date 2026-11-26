import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiApp } from './server/app.ts';
import { connectDatabase } from './server/config/db.ts';
import { getEnvConfig, getProductionReadinessReport } from './server/config/env.ts';
import { logEvent } from './server/utils/logger.ts';
import { recoverInterruptedCampaigns } from './server/utils/campaignWorker.ts';
import { recoverInterruptedResearchJobs } from './server/utils/leadResearcher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function bootstrap() {
  const env = getEnvConfig();
  const app = createApiApp({ ensureDbOnRequest: false });

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

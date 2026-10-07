import { Router } from 'express';
import { runReadinessChecks } from './health.registry';

export const healthRouter = Router();

// Liveness: "is the process running?" Failing => orchestrator restarts the container.
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: "can it serve traffic?" Failing => removed from load balancing (not restarted).
healthRouter.get('/ready', async (_req, res) => {
  const checks = await runReadinessChecks();
  const ready = checks.every((c) => c.ok);
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

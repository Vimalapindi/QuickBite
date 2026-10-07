import type { RequestHandler } from 'express';
import { httpRequestDuration, httpRequestsTotal } from '../../infra/metrics/metrics';

/** Records RED metrics (Rate, Errors, Duration) per route template, e.g. /api/orders/:id (low cardinality). */
export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    if (route === '/metrics') return;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
    httpRequestsTotal.inc(labels);
  });
  next();
};

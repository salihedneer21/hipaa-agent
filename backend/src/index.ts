/**
 * HIPAA Compliance Agent - Backend Server
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import logger from './utils/logger.js';
import { setTraceProcessors, setTracingDisabled } from '@openai/agents';

// Load env vars from either the current directory (.env) OR the repo root (.env).
// This prevents a common local-dev pitfall where you run `pnpm --dir backend dev`
// but your `.env` lives at the repo root.
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env'), override: false });

// Disable OpenAI Agents tracing by default to avoid noisy export failures in restricted networks.
// Set HIPAA_AGENT_ENABLE_TRACING=1 to re-enable.
const enableTracing = process.env.HIPAA_AGENT_ENABLE_TRACING === '1' || process.env.HIPAA_AGENT_ENABLE_TRACING === 'true';
if (!enableTracing) {
  setTracingDisabled(true);
  setTraceProcessors([]);
  logger.info('OpenAI Agents tracing disabled');
}

// Import routes AFTER tracing is configured, so agent modules don't initialize tracing exporters in restricted networks.
const { default: analysisRoutes } = await import('./routes/analysis.js');

const app: express.Express = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', analysisRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'HIPAA Compliance Agent - Backend started');
  logger.info({ endpoints: [
    'POST /api/analyze - Start async analysis',
    'GET /api/analyze/:id - Get analysis status',
    'POST /api/analyze-quick - Quick sync analysis',
    'GET /health - Health check',
  ]}, 'Available endpoints');
});

export default app;

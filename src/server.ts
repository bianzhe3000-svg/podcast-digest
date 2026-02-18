import dns from 'dns';
import express from 'express';
import path from 'path';
import { config, ensureDirectories } from './config';
import { logger } from './utils/logger';
import { getDatabase } from './database';
import { startScheduler } from './scheduler';
import apiRoutes from './web/routes';

// Force Node.js to prefer IPv4 globally (fixes Railway IPv6 connection failures)
dns.setDefaultResultOrder('ipv4first');

// Ensure required directories exist
ensureDirectories();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Start server (Railway sets PORT env var)
const port = parseInt(process.env.PORT || String(config.api.port), 10);
const host = process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : config.api.host;
const server = app.listen(port, host, () => {
  logger.info(`Server started on http://${host}:${port}`);

  // Initialize database
  getDatabase();

  // Auto-start scheduler if enabled
  if (config.scheduler.enabled) {
    try {
      startScheduler();
      logger.info('Scheduler auto-started');
    } catch (error) {
      logger.error('Failed to auto-start scheduler', { error: (error as Error).message });
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  server.close(() => {
    getDatabase().close();
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => {
    getDatabase().close();
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

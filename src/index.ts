import { pino } from 'pino';
import { loadConfigFile, loadEnv } from './config.js';
import { createGateway } from './gateway.js';
import { startTelemetry } from './telemetry/sdk.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]'],
  });
  const config = loadConfigFile(env.TOLLGATE_CONFIG);
  const stopTelemetry = startTelemetry(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_SERVICE_NAME);
  const gateway = await createGateway(config, env, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await gateway.close();
    await stopTelemetry?.();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await gateway.app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT }, 'tollgate listening');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

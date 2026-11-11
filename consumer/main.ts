import { Kafka, logLevel } from 'kafkajs';
import { pino } from 'pino';
import { createPool, migrate, PgUsageRepository } from '../src/db/pg.js';
import type { UsageEvent } from '../src/usage/events.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
};

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const brokers = required('KAFKA_BROKERS').split(',').map((b) => b.trim());
const topic = process.env.KAFKA_TOPIC ?? 'llm.usage';
const groupId = process.env.KAFKA_GROUP_ID ?? 'tollgate-usage-writer';

const pool = createPool(required('DATABASE_URL'));
await migrate(pool, process.env.MIGRATIONS_DIR ?? 'migrations');
const repo = new PgUsageRepository(pool);

const kafka = new Kafka({ clientId: 'tollgate-consumer', brokers, logLevel: logLevel.NOTHING });
const consumer = kafka.consumer({ groupId });

await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });

await consumer.run({
  eachBatchAutoResolve: false,
  eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
    const events: UsageEvent[] = [];
    for (const message of batch.messages) {
      if (!message.value) continue;
      try {
        events.push(JSON.parse(message.value.toString()) as UsageEvent);
      } catch {
        logger.warn({ offset: message.offset }, 'skipping malformed usage event');
      }
    }
    await repo.insertMany(events);
    const last = batch.messages[batch.messages.length - 1];
    if (last) resolveOffset(last.offset);
    await commitOffsetsIfNecessary();
    await heartbeat();
    logger.debug({ count: events.length }, 'usage batch written');
  },
});

logger.info({ topic, groupId }, 'usage consumer running');

const stop = async () => {
  await consumer.disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

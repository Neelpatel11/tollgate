import { buildMock, loadFixtures } from './server.js';

const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const app = await buildMock({
  logger: process.env.MOCK_LOG === '1',
  fixtures: loadFixtures(process.env.MOCK_FIXTURES),
  state: {
    latencyMs: num('MOCK_LATENCY_MS', 0),
    jitterMs: num('MOCK_JITTER_MS', 0),
    errorRate: num('MOCK_ERROR_RATE', 0),
    errorStatus: num('MOCK_ERROR_STATUS', 500),
    hangRate: num('MOCK_HANG_RATE', 0),
    streamDelayMs: num('MOCK_STREAM_DELAY_MS', 0),
    replyWords: num('MOCK_REPLY_WORDS', 24),
  },
});

const port = Number(flag('port') ?? num('MOCK_PORT', 9100));
await app.listen({ port, host: '0.0.0.0' });
console.log(`mock provider listening on :${port}`);

import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { UsageEvent, UsageSink } from './events.js';

export interface KafkaSinkOptions {
  brokers: string[];
  topic: string;
  clientId: string;
  maxQueue?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  onDrop?: (count: number) => void;
  onError?: (err: unknown) => void;
}

export class KafkaUsageSink implements UsageSink {
  private readonly producer: Producer;
  private queue: UsageEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private connected = false;
  private connecting: Promise<void> | undefined;
  private flushing = false;
  private closed = false;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly opts: KafkaSinkOptions) {
    const kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 5, initialRetryTime: 200 },
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: true });
    this.maxQueue = opts.maxQueue ?? 10_000;
    this.batchSize = opts.batchSize ?? 200;
    this.flushIntervalMs = opts.flushIntervalMs ?? 250;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  emit(event: UsageEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      const dropped = this.queue.length - this.maxQueue;
      this.queue.splice(0, dropped);
      this.opts.onDrop?.(dropped);
    }
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  private connect(): Promise<void> {
    this.connecting ??= this.producer
      .connect()
      .then(() => {
        this.connected = true;
      })
      .catch((err: unknown) => {
        this.connecting = undefined;
        throw err;
      });
    return this.connecting;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.batchSize);
    try {
      if (!this.connected) await this.connect();
      await this.producer.send({
        topic: this.opts.topic,
        messages: batch.map((e) => ({ key: e.key_id, value: JSON.stringify(e) })),
      });
    } catch (err) {
      this.opts.onError?.(err);
      this.queue.unshift(...batch);
      if (this.queue.length > this.maxQueue) {
        const dropped = this.queue.length - this.maxQueue;
        this.queue.splice(this.maxQueue, dropped);
        this.opts.onDrop?.(dropped);
      }
    } finally {
      this.flushing = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (let i = 0; i < 20 && this.queue.length > 0; i++) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length >= before) break;
    }
    if (this.connected) await this.producer.disconnect().catch(() => undefined);
  }
}

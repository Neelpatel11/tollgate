import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export function startTelemetry(endpoint: string | undefined, serviceName: string): (() => Promise<void>) | null {
  if (!endpoint) return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
  });
  sdk.start();
  return () => sdk.shutdown();
}

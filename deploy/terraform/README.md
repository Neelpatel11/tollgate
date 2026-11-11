# Terraform: GKE Autopilot, Memorystore, Cloud SQL

Provisions the stateful pieces Tollgate needs on GCP:

| Resource | Purpose |
|---|---|
| VPC, subnet, private services access | Private connectivity to Redis and Postgres |
| GKE Autopilot cluster | Runs the Helm chart in `deploy/helm/tollgate` |
| Memorystore for Redis | Exact cache and rate-limit state |
| Cloud SQL for PostgreSQL 16 | API keys and usage events |
| Artifact Registry | Container images |

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

Then build and push the image, create the Kubernetes Secret from the outputs,
and install the chart:

```bash
gcloud container clusters get-credentials tollgate-gke --region asia-south1

kubectl create secret generic tollgate-secrets \
  --from-literal=ADMIN_API_KEY="$(openssl rand -hex 24)" \
  --from-literal=REDIS_URL="$(terraform output -raw redis_url)" \
  --from-literal=DATABASE_URL="$(terraform output -raw database_url)" \
  --from-literal=KAFKA_BROKERS="<broker:9092>" \
  --from-literal=OPENAI_API_KEY="..." \
  --from-literal=ANTHROPIC_API_KEY="..." \
  --from-literal=GEMINI_API_KEY="..."

helm install tollgate ../helm/tollgate \
  --set image.repository="$(terraform output -raw artifact_registry)/tollgate" \
  --set image.tag=0.1.0
```

## Notes

- **Kafka is not provisioned here.** Point `KAFKA_BROKERS` at any Kafka-protocol
  broker: Redpanda or Strimzi running in the cluster, or a managed service. The
  producer in `src/usage/kafka.ts` uses plaintext connections; add SASL options
  there if your broker requires authentication.
- **Semantic cache needs RediSearch.** Memorystore does not include it. Either
  leave `cache.semantic.enabled: false` (the chart default) or run Redis Stack
  / Redis 8 and set `REDIS_VECTOR_URL` in the Secret.
- The usage pipeline degrades safely: if Kafka is unreachable the gateway
  buffers a bounded number of events in memory, then drops the oldest and
  increments `tollgate_usage_events_dropped_total`. Requests are never blocked.
- State holds a generated database password. Use a remote backend with
  encryption for real deployments.

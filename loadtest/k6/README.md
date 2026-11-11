# k6 scripts

Equivalents of the Node benchmark in `loadtest/bench.ts`, for running against a
Compose or cluster deployment.

```bash
docker compose -f deploy/docker-compose.yml --profile mock up -d

# Added latency at a fixed arrival rate (direct to mock, then through the gateway)
k6 run -e RATE=500 -e ALIAS=smart loadtest/k6/overhead.js

# Primary provider failure while traffic flows. Flip the primary mock mid-run:
#   curl -XPOST localhost:9101/control -d '{"errorRate":1}' -H 'content-type: application/json'
k6 run loadtest/k6/failover.js
```

Point the `smart` alias at the mock provider in your config to measure the
gateway without provider variance. The mock accepts `latencyMs`, `errorRate`,
`errorStatus`, `hangRate` and `streamDelayMs` at `POST /control`.

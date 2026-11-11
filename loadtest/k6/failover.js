import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const GATEWAY = __ENV.GATEWAY_URL || 'http://localhost:8080';
const KEY = __ENV.TOLLGATE_KEY || 'tg_dev_local_key';
const ALIAS = __ENV.ALIAS || 'failover';
const PRIMARY_CONTROL = __ENV.PRIMARY_CONTROL || 'http://localhost:9101';

const served = new Rate('served');

export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    served: ['rate>0.99'],
  },
};

export function setup() {
  http.post(`${PRIMARY_CONTROL}/control/reset`);
}

export default function () {
  const res = http.post(
    `${GATEWAY}/v1/chat/completions`,
    JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: `failover probe ${__ITER}` }] }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` } },
  );
  served.add(res.status === 200);
  check(res, { 'status 200': (r) => r.status === 200 });
}

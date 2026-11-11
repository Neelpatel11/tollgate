import http from 'k6/http';
import { check } from 'k6';

const GATEWAY = __ENV.GATEWAY_URL || 'http://localhost:8080';
const MOCK = __ENV.MOCK_URL || 'http://localhost:9100';
const KEY = __ENV.TOLLGATE_KEY || 'tg_dev_local_key';
const ALIAS = __ENV.ALIAS || 'bench';
const RATE = Number(__ENV.RATE || 500);

export const options = {
  scenarios: {
    direct: {
      executor: 'constant-arrival-rate',
      exec: 'direct',
      rate: RATE,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
    gateway: {
      executor: 'constant-arrival-rate',
      exec: 'viaGateway',
      rate: RATE,
      timeUnit: '1s',
      duration: '60s',
      startTime: '70s',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    'http_req_duration{scenario:direct}': ['p(95)<100'],
    'http_req_duration{scenario:gateway}': ['p(95)<120'],
    'http_req_failed{scenario:gateway}': ['rate<0.001'],
  },
};

const headers = { 'Content-Type': 'application/json' };
const messages = [{ role: 'user', content: 'overhead probe' }];

export function direct() {
  const res = http.post(`${MOCK}/v1/chat/completions`, JSON.stringify({ model: 'mock', messages }), { headers });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export function viaGateway() {
  const res = http.post(`${GATEWAY}/v1/chat/completions`, JSON.stringify({ model: ALIAS, messages }), {
    headers: { ...headers, Authorization: `Bearer ${KEY}` },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}

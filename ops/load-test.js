import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import {
  browsePath,
  loadProfile,
  restaurantIds,
  thresholds,
} from './load-test.lib.mjs';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4000/api').replace(/\/$/, '');
const profile = __ENV.PROFILE || 'smoke';

export const options = {
  scenarios: loadProfile(profile),
  thresholds,
  discardResponseBodies: false,
  userAgent: 'foodorder-k6',
};

export function setup() {
  const response = http.get(`${baseUrl}/restaurants?sort=rating&limit=20`, {
    tags: { endpoint: 'restaurants-bootstrap' },
  });
  const ok = check(response, {
    'bootstrap status is 200': (res) => res.status === 200,
  });
  if (!ok) exec.test.abort(`Bootstrap failed with HTTP ${response.status}`);

  let payload;
  try {
    payload = response.json();
  } catch (error) {
    exec.test.abort(`Bootstrap returned invalid JSON: ${error.message}`);
  }

  let ids;
  try {
    ids = restaurantIds(payload);
  } catch (error) {
    exec.test.abort(error.message);
  }
  return { restaurantIds: ids };
}

export default function browse(data) {
  const iteration = exec.scenario.iterationInTest;
  const ids = data.restaurantIds;
  const restaurantId = ids[iteration % ids.length];
  const path = browsePath(iteration, restaurantId);
  const response = http.get(`${baseUrl}${path}`, {
    tags: { endpoint: path.startsWith('/restaurants/') ? 'restaurant-detail' : path },
  });

  check(response, {
    'status is 200': (res) => res.status === 200,
    'response is JSON': (res) => String(res.headers['Content-Type'] || '').includes('application/json'),
    'response has no error envelope': (res) => !res.body?.includes('"error"'),
  });
  sleep(0.2);
}

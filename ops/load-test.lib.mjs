export const thresholds = Object.freeze({
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  checks: ['rate>0.99'],
});

const profiles = Object.freeze({
  smoke: Object.freeze({
    browse: Object.freeze({
      executor: 'constant-vus',
      vus: 1,
      duration: '15s',
      gracefulStop: '5s',
    }),
  }),
  load: Object.freeze({
    browse: Object.freeze({
      executor: 'ramping-vus',
      startVUs: 0,
      stages: Object.freeze([
        Object.freeze({ duration: '30s', target: 10 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '1m', target: 25 }),
        Object.freeze({ duration: '30s', target: 0 }),
      ]),
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    }),
  }),
});

export function loadProfile(name) {
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown load-test profile: ${name}. Expected smoke or load.`);
  }
  return profile;
}

export function restaurantIds(payload) {
  const ids = payload?.items
    ?.map((item) => item?.id)
    .filter((id) => typeof id === 'string' && id.length > 0);
  if (!ids?.length) throw new Error('No restaurant ids found in bootstrap response.');
  return ids;
}

export function browsePath(iteration, restaurantId) {
  const paths = [
    '/restaurants?sort=rating&limit=20',
    '/restaurants/meta/cuisines',
    `/restaurants/${restaurantId}`,
    '/restaurants?search=rice&limit=20',
  ];
  return paths[iteration % paths.length];
}

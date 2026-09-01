import http from 'k6/http';
import { check, group } from 'k6';
import { Counter } from 'k6/metrics';

// Public frontend URL. Requests go through nginx and then the backend's
// internal ingress: the real path a user's traffic takes, not a shortcut to
// the backend that would measure something nobody experiences.
//
// Read it from Terraform rather than trusting this default, which goes stale
// as soon as the environment is recreated:
//   terraform -chdir=infra output -raw frontend_url
const BASE_URL = __ENV.BASE_URL || 'https://ca-sgtest-frontend.lemonsmoke-7b6c27a7.francecentral.azurecontainerapps.io';

// Counts responses per replica. meta.instance is what makes traffic spread
// visible from the client side, independently of what the platform reports.
const responsesByInstance = new Counter('responses_by_instance');

export const options = {
  // The autoscale rule triggers above 10 concurrent requests per replica, and
  // KEDA polls every 30s. The plateau is long enough for that cycle to happen
  // AND for the new replicas to actually serve traffic.
  stages: [
    { duration: '30s', target: 10 }, // warm-up, still one replica
    { duration: '1m', target: 60 },  // cross the threshold
    { duration: '2m', target: 60 },  // plateau: scale-out and stabilisation
    { duration: '30s', target: 0 }   // ramp down
  ],

  // The test fails if the system degrades. These are assertions, not
  // observations: a load test that cannot fail proves nothing.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500']
  }
};

// Replicas already seen by this VU.
const seen = new Set();

function track(res) {
  if (res.status !== 200) return;
  try {
    const instance = res.json('meta.instance');
    if (!instance) return;
    responsesByInstance.add(1, { instance });
    if (!seen.has(instance)) {
      seen.add(instance);
      console.log(`VU ${__VU} served by replica: ${instance}`);
    }
  } catch (e) {
    // Non-JSON body under stress: already counted as a failed check.
  }
}

// Read-only on purpose. POST /api/transfers debits a finite in-memory
// balance, so a sustained write load would drain the accounts and return 422s
// that the failure threshold would count as errors — measuring the fixture,
// not the system. The write path is covered by unit tests instead.
export default function () {
  group('dashboard', () => {
    const responses = http.batch([
      ['GET', `${BASE_URL}/api/accounts`],
      ['GET', `${BASE_URL}/api/transactions`]
    ]);

    check(responses[0], {
      'accounts: 200': (r) => r.status === 200,
      'accounts: json body': (r) => r.json('data') !== undefined
    });
    check(responses[1], { 'transactions: 200': (r) => r.status === 200 });

    responses.forEach(track);
  });

  group('beneficiaries', () => {
    const res = http.get(`${BASE_URL}/api/beneficiaries`);
    check(res, { 'beneficiaries: 200': (r) => r.status === 200 });
    track(res);
  });
}

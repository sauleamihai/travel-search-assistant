import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';

// Override credentials before importing the app. No test uses paid services.
process.env.GROQ_API_KEY = 'test-groq';
process.env.SERPAPI_API_KEY = 'test-serp';
process.env.SEARCHAPI_API_KEY = 'test-search';
process.env.APIFY_TOKEN = '';
process.env.TRUST_PROXY_HOPS = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected external request in test'); };
const { app } = await import('../src/server.js');
let server;
let base;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  globalThis.fetch = async () => { throw new Error('Unexpected external request in test'); };
  process.env.SERPAPI_API_KEY = 'test-serp';
  process.env.SEARCHAPI_API_KEY = 'test-search';
  process.env.APIFY_TOKEN = '';
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
const get = path => realFetch(base + path);
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('health and browser assets load without provider calls', async () => {
  assert.deepEqual(await (await get('/healthz')).json(), { status: 'ok' });
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Travel Search/);
  for (const path of ['/airports.json', '/cities.json']) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).length > 0);
  }
});

test('missing search parameters and chat inputs return 400', async () => {
  for (const path of ['/api/hotels', '/api/airbnb', '/api/flights']) {
    assert.equal((await get(path)).status, 400);
  }
  const response = await realFetch(base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
});

test('missing search credentials return 503 without contacting providers', async () => {
  process.env.SERPAPI_API_KEY = '';
  process.env.SEARCHAPI_API_KEY = '';
  for (const path of [
    '/api/hotels?location=Rome&checkIn=2030-06-10&checkOut=2030-06-12',
    '/api/airbnb?location=Rome&checkIn=2030-06-10&checkOut=2030-06-12',
    '/api/flights?departureId=OTP&arrivalId=LHR&outboundDate=2030-06-10',
  ]) assert.equal((await get(path)).status, 503);
});

test('hotel search forwards dates and guests and caps normalized results at ten', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const query = new URL(url);
    assert.equal(query.hostname, 'serpapi.com');
    assert.equal(query.searchParams.get('engine'), 'google_hotels');
    assert.equal(query.searchParams.get('adults'), '2');
    assert.equal(query.searchParams.get('check_in_date'), '2030-06-10');
    return json({ properties: Array.from({ length: 12 }, () => ({ name: 'Hotel', rate_per_night: { lowest: '$120' } })) });
  };
  const response = await get('/api/hotels?location=Rome&checkIn=2030-06-10&checkOut=2030-06-12&adults=2');
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.equal(results.length, 10);
  assert.equal(results[0].pricePerNight, '$120');
  assert.equal(results[0].image, null);
  assert.equal(calls, 1);
});

test('Airbnb results preserve booking links and price fields', async () => {
  globalThis.fetch = async url => {
    assert.equal(new URL(url).hostname, 'www.searchapi.io');
    return json({ properties: [{ title: 'Apartment', booking_link: 'https://example.com/stay', price: { price_per_qualifier: '$90' } }] });
  };
  const { results } = await (await get('/api/airbnb?location=Rome&checkIn=2030-06-10&checkOut=2030-06-12')).json();
  assert.equal(results[0].title, 'Apartment');
  assert.equal(results[0].link, 'https://example.com/stay');
  assert.equal(results[0].price, '$90');
});

test('upstream hotel failure returns 502', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  assert.equal((await get('/api/hotels?location=Rome&checkIn=2030-06-10&checkOut=2030-06-12')).status, 502);
});

test('flight search selects one-way or round-trip and normalizes connections', async () => {
  const tripTypes = [];
  globalThis.fetch = async url => {
    tripTypes.push(new URL(url).searchParams.get('type'));
    return json({ best_flights: [{ price: 150, total_duration: 200, flights: [{ airline: 'A' }, { airline: 'B' }] }], price_insights: { lowest_price: 150 } });
  };
  const path = '/api/flights?departureId=OTP&arrivalId=LHR&outboundDate=2030-06-10';
  const data = await (await get(path)).json();
  await get(path + '&returnDate=2030-06-15');
  assert.deepEqual(tripTypes, ['2', '1']);
  assert.equal(data.results[0].stops, 1);
  assert.equal(data.results[0].price, 150);
  assert.equal(data.source, 'google_flights');
  assert.equal(data.lowestPrice, 150);
});

test('empty Google results do not invoke a disabled fallback', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}); };
  const data = await (await get('/api/flights?departureId=OTP&arrivalId=LHR&outboundDate=2030-06-10')).json();
  assert.deepEqual(data.results, []);
  assert.equal(calls, 1);
});

test('Apify fallback filters error items and synthesizes missing segments', async () => {
  process.env.APIFY_TOKEN = 'test-apify';
  const hosts = [];
  globalThis.fetch = async (url, options) => {
    const hostname = new URL(url).hostname;
    hosts.push(hostname);
    if (hostname === 'serpapi.com') return json({});
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).origin, 'OTP');
    return json([
      { error: 'No flights found' },
      { bestPrice: 80, airline: 'Example Air', from: { airport: 'OTP' }, to: { airport: 'LHR' }, duration: '3h 20m', segments: [], links: { googleFlights: 'https://example.com/flight' } },
    ]);
  };
  const data = await (await get('/api/flights?departureId=OTP&arrivalId=LHR&outboundDate=2030-06-10')).json();
  assert.deepEqual(hosts, ['serpapi.com', 'api.apify.com']);
  assert.equal(data.source, 'apify');
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].totalDuration, 200);
  assert.equal(data.results[0].segments[0].departureAirport, 'OTP');
  assert.equal(data.results[0].bookingUrl, 'https://example.com/flight');
});

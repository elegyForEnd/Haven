'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnimeService } = require('../src/anime-service');

function fixture() {
  let failures = 1, calendarRequests = 0, trendingRequests = 0;
  const days = [{ weekday: { id: 7, cn: '星期日' }, items: [{ id: 42, type: 2, name: '周日新番' }] }];
  const service = createAnimeService({ fetchImpl: async url => {
    if (url.endsWith('/calendar')) {
      calendarRequests++;
      if (failures-- > 0) throw new Error('temporary calendar outage');
      return { ok: true, json: async () => days };
    }
    if (url.includes('/trending/subjects')) {
      trendingRequests++;
      return { ok: true, json: async () => ({ data: [{ subject: { id: 1, type: 2, name: '推荐番剧' } }] }) };
    }
    if (url.endsWith('/v0/subjects/1')) return { ok: true, json: async () => ({ id: 1, type: 2, name: '推荐番剧' }) };
    throw new Error('Unexpected URL: ' + url);
  } });
  return { service, counts: () => ({ calendarRequests, trendingRequests }) };
}

test('home retries a missing calendar without keeping a transient outage for the full homepage cache TTL', async () => {
  const { service, counts } = fixture();
  const first = await service.home();
  assert.equal(first.featured.length, 1);
  assert.equal(first.calendar.length, 0);
  const recovered = await service.home();
  assert.equal(recovered.calendar[0].items[0].name, '周日新番');
  assert.equal(recovered.calendar[0].weekday.id, 7);
  assert.deepEqual(counts(), { calendarRequests: 2, trendingRequests: 1 });
});

test('a successful standalone calendar request repairs an already cached empty home calendar', async () => {
  const { service, counts } = fixture();
  await service.home();
  const days = await service.calendar();
  const home = await service.home();
  assert.deepEqual(home.calendar, days);
  assert.equal(home.calendar.length, 1);
  assert.deepEqual(counts(), { calendarRequests: 2, trendingRequests: 1 });
});

test('concurrent requests recovering the home calendar share a single upstream fetch', async () => {
  const { service, counts } = fixture();
  await service.home();
  const results = await Promise.all(Array.from({ length: 8 }, () => service.home()));
  assert.ok(results.every(home => home.calendar[0].items.length === 1));
  assert.deepEqual(counts(), { calendarRequests: 2, trendingRequests: 1 });
});

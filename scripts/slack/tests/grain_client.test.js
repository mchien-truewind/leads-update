const test = require('node:test');
const assert = require('node:assert/strict');

const { GrainClient, normalizeInclude } = require('../sales_admin/grain_client');

test('sales admin Grain client normalizes include arrays to v2 include object', () => {
  assert.deepEqual(normalizeInclude(['participants', 'ai_summary']), {
    participants: true,
    ai_summary: true,
  });
  assert.deepEqual(normalizeInclude({ participants: true }), { participants: true });
});

test('sales admin Grain client lists recordings using v2 POST schema', async () => {
  const calls = [];
  const client = new GrainClient({
    token: 'grain-test',
    httpRequest: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        recordings: [
          { id: 'before-window', start_datetime: '2026-06-03T19:30:00Z' },
          { id: 'in-window', start_datetime: '2026-06-03T20:30:04Z' },
          { id: 'after-window', start_datetime: '2026-06-03T21:30:00Z' },
        ],
      };
    },
  });

  const recordings = await client.listRecordings({
    start: new Date('2026-06-03T19:45:00Z'),
    end: new Date('2026-06-03T21:15:00Z'),
    teamId: '58594e3b-292b-4ca2-aa35-417cf13addf1',
    include: ['participants', 'ai_action_items'],
  });

  assert.deepEqual(recordings.map(recording => recording.id), ['in-window']);
  assert.deepEqual(calls[0].body.include, { participants: true, ai_action_items: true });
  assert.equal(Object.hasOwn(calls[0].body, 'limit'), false);
  assert.equal(Object.hasOwn(calls[0].body.filter, 'start_time'), false);
  assert.equal(calls[0].body.filter.after_datetime, '2026-06-03T21:15:00.000Z');
  assert.equal(calls[0].body.filter.team, '58594e3b-292b-4ca2-aa35-417cf13addf1');
});

test('sales admin Grain client gets recording details using v2 include object', async () => {
  const calls = [];
  const client = new GrainClient({
    token: 'grain-test',
    httpRequest: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { id: 'recording-1' };
    },
  });

  const recording = await client.getRecording('recording-1');

  assert.equal(recording.id, 'recording-1');
  assert.equal(calls[0].url, 'https://api.grain.com/_/public-api/v2/recordings/recording-1');
  assert.deepEqual(calls[0].body.include, {
    participants: true,
    ai_action_items: true,
    ai_summary: true,
    calendar_event: true,
    hubspot: true,
  });
});

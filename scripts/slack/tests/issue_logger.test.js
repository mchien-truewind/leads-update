const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ISSUE_CHANNEL, ISSUE_SHEET, createIssueLogger, readIssueThread, analyzeIssue } = require('../issue_logger');

function fixture() {
  let request = null;
  const rows = [['Category', 'Description of Issue', 'Slack Link']];
  const replies = [], writes = [];
  let question = { action: 'log', category: 'HubSpot', description: 'Demo booking creates duplicate contacts.' };
  let failAfterWrite = false;
  const state = {
    get: async () => request,
    clarify: async (channel, thread, user) => { request ||= { requester_id: user, status: 'clarifying' }; },
    reserve: async (channel, thread, user, row, cells) => (request = { requester_id: user, status: 'reserved', sheet_row: row, cells }),
    complete: async () => { request.status = 'completed'; },
  };
  const sheets = { spreadsheets: { values: {
    get: async ({ range }) => ({ data: { values: range === 'Sheet1!A:C' ? rows : rows.slice(request.sheet_row - 1, request.sheet_row) } }),
    update: async input => {
      writes.push(input);
      rows[request.sheet_row - 1] = input.requestBody.values[0];
      if (failAfterWrite) { failAfterWrite = false; throw new Error('lost response'); }
    },
  } } };
  const analysis = [];
  const handle = createIssueLogger({
    store: { withLock: fn => fn(state) }, sheets,
    readThread: async () => [{ user: 'U_ORIGINAL', text: 'Demo booking created the same contact twice.' }],
    analyze: async input => { analysis.push(input); return question; }, logger: { error() {} },
  });
  const run = overrides => handle({ channel: ISSUE_CHANNEL, threadTs: '123.456', userId: 'U_ORIGINAL', text: 'log this issue', say: async m => replies.push(m), ...overrides });
  return { run, rows, replies, writes, analysis, get request() { return request; }, decide: d => { question = d; }, fail: () => { failAfterWrite = true; } };
}

test('any requester in #leads can log; writes existing columns as RAW with server-owned source link', async () => {
  const f = fixture();
  assert.equal(await f.run({ userId: 'U_TEAMMATE' }), true);
  assert.equal(f.request.requester_id, 'U_TEAMMATE');
  assert.equal(f.writes[0].spreadsheetId, ISSUE_SHEET);
  assert.equal(f.writes[0].valueInputOption, 'RAW');
  assert.deepEqual(f.rows[1], ['HubSpot', 'Demo booking creates duplicate contacts.', `https://truewindai.slack.com/archives/${ISSUE_CHANNEL}/p123456`]);
  assert.equal(f.request.status, 'completed');
});
test('other channels cannot use this workflow', async () => {
  const f = fixture(); assert.equal(await f.run({ channel: 'C_OTHER' }), false); assert.equal(f.analysis.length, 0); assert.equal(f.writes.length, 0);
});
test('general conversation falls through without writing', async () => {
  const f = fixture(); f.decide({ action: 'ignore' }); assert.equal(await f.run(), false); assert.equal(f.writes.length, 0);
});
test('unclear issue tags original requester and waits; their clarification writes once', async () => {
  const f = fixture(); f.decide({ action: 'clarify', question: 'What happened when you booked the demo?' });
  await f.run(); assert.equal(f.writes.length, 0); assert.match(f.replies[0].text, /^<@U_ORIGINAL>/);
  await f.run({ userId: 'U_OTHER', text: 'log it' }); assert.equal(f.analysis.length, 1); assert.match(f.replies[1].text, /^<@U_ORIGINAL>/); assert.equal(f.writes.length, 0);
  f.decide({ action: 'log', category: 'Demo booking', description: 'Two contacts created for the same booking.' });
  await f.run({ text: 'It creates two contacts for one booking.' });
  assert.equal(f.analysis[1].pending_clarification, true); assert.equal(f.writes.length, 1);
});
test('ambiguous write timeout retries the same committed row and payload', async () => {
  const f = fixture(); f.fail(); await f.run(); assert.equal(f.request.status, 'reserved');
  f.decide({ action: 'log', category: 'Wrong', description: 'Different model output.' });
  await f.run({ text: 'retry' });
  assert.equal(f.analysis.length, 1); assert.equal(f.writes.length, 2); assert.equal(f.rows.length, 2);
  assert.deepEqual(f.writes[0], f.writes[1]); assert.equal(f.request.status, 'completed');
});
test('an occupied reservation fails without overwriting someone else’s cells', async () => {
  const f = fixture(); f.fail(); await f.run(); f.rows[1] = ['Other', 'Manual edit', 'source']; await f.run();
  assert.equal(f.writes.length, 1); assert.equal(f.request.status, 'reserved'); assert.equal(f.rows[1][1], 'Manual edit');
});
test('completed requests do not duplicate rows or intercept unrelated questions', async () => {
  const f = fixture(); await f.run(); await f.run({ userId: 'U_OTHER' }); assert.equal(f.writes.length, 1); assert.match(f.replies[1].text, /already/);
  f.decide({ action: 'ignore' }); assert.equal(await f.run({ text: 'What is our lead count?' }), false);
});
test('changed sheet headers prevent writes', async () => {
  const f = fixture(); f.rows[0][0] = 'Changed'; await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.request, null);
});
test('thread reading paginates and falls back to configured user token', async () => {
  const calls = [];
  const slack = { conversations: { replies: async input => {
    calls.push(input);
    if (input.token === 'bad') throw new Error('missing_scope');
    return input.cursor ? { ok: true, messages: [{ ts: '2', text: 'second' }] } : { ok: true, messages: [{ ts: '1', text: 'first' }], has_more: true, response_metadata: { next_cursor: 'next' } };
  } } };
  const messages = await readIssueThread(slack, ['bad', 'good'], ISSUE_CHANNEL, '1');
  assert.deepEqual(messages.map(m => m.text), ['first', 'second']); assert.equal(calls.length, 3);
});
test('incomplete thread is rejected instead of silently logging partial context', async () => {
  const slack = { conversations: { replies: async () => ({ ok: true, messages: [{ ts: '1', text: 'first' }], has_more: true }) } };
  await assert.rejects(readIssueThread(slack, ['token'], ISSUE_CHANNEL, '1'), /thread_unavailable/);
});
test('malformed model response is rejected', async () => {
  const anthropic = { messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'issue_decision', input: { action: 'log', category: 'Demo' } }] }) } };
  await assert.rejects(analyzeIssue(anthropic, 'test', {}), /invalid_issue_decision/);
});

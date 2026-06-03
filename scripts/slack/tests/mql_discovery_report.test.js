const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NEXT_MEETING_PROPERTY,
  MQL_ENTERED_PROPERTY,
  MQL_EXITED_PROPERTY,
  analyzeMqlDiscoveryDeals,
  getNextBusinessDayWindow,
  wasMqlAtStartOfDay,
} = require('../mql_discovery_report');

function deal(id, properties, history = {}) {
  return {
    id,
    properties: {
      dealname: `Deal ${id}`,
      pipeline: '105321581',
      ...properties,
    },
    propertiesWithHistory: history,
  };
}

test('next business day skips the weekend using Pacific boundaries', () => {
  const fridayNoonPacific = new Date('2026-06-05T19:00:00.000Z');
  const window = getNextBusinessDayWindow(fridayNoonPacific);

  assert.equal(window.start.toISOString(), '2026-06-08T07:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-06-09T07:00:00.000Z');
});

test('MQL-as-of-start requires entered before midnight and no prior exit', () => {
  const startOfDay = new Date('2026-06-02T07:00:00.000Z');

  assert.equal(wasMqlAtStartOfDay(deal('1', {
    [MQL_ENTERED_PROPERTY]: '2026-06-01T20:00:00.000Z',
    [MQL_EXITED_PROPERTY]: '',
  }), startOfDay), true);

  assert.equal(wasMqlAtStartOfDay(deal('2', {
    [MQL_ENTERED_PROPERTY]: '2026-06-02T08:00:00.000Z',
    [MQL_EXITED_PROPERTY]: '',
  }), startOfDay), false);

  assert.equal(wasMqlAtStartOfDay(deal('3', {
    [MQL_ENTERED_PROPERTY]: '2026-06-01T20:00:00.000Z',
    [MQL_EXITED_PROPERTY]: '2026-06-02T06:59:59.000Z',
  }), startOfDay), false);
});

test('report groups current outcomes and detects changed next meeting values', () => {
  const report = analyzeMqlDiscoveryDeals([
    deal('mql-tomorrow', {
      dealstage: '1307720553',
      [NEXT_MEETING_PROPERTY]: '2026-06-03T17:00:00.000Z',
      [MQL_ENTERED_PROPERTY]: '2026-06-01T20:00:00.000Z',
      [MQL_EXITED_PROPERTY]: '',
    }),
    deal('advanced', {
      dealstage: '190380582',
      [NEXT_MEETING_PROPERTY]: '2026-06-02T18:00:00.000Z',
      [MQL_ENTERED_PROPERTY]: '2026-06-01T20:00:00.000Z',
      [MQL_EXITED_PROPERTY]: '2026-06-02T19:00:00.000Z',
    }),
    deal('rescheduled', {
      dealstage: '1307720553',
      [NEXT_MEETING_PROPERTY]: '2026-06-04T18:00:00.000Z',
      [MQL_ENTERED_PROPERTY]: '2026-06-01T20:00:00.000Z',
      [MQL_EXITED_PROPERTY]: '',
    }, {
      [NEXT_MEETING_PROPERTY]: [{ value: '2026-06-02T18:00:00.000Z' }],
    }),
    deal('missing-history', {
      dealstage: '1307720553',
      [NEXT_MEETING_PROPERTY]: '2026-06-02T18:00:00.000Z',
      [MQL_ENTERED_PROPERTY]: '',
      [MQL_EXITED_PROPERTY]: '',
    }),
  ], { now: new Date('2026-06-02T20:00:00.000Z') });

  assert.equal(report.currentNextBusinessDayMqlDeals.length, 1);
  assert.equal(report.todaysCallDeals.length, 2);
  assert.equal(report.outcomes.advancedOpen.length, 1);
  assert.equal(report.outcomes.rescheduledFuture.length, 1);
  assert.match(report.dataQualityNotes.join('\n'), /current value is 2026-06-04T18:00:00.000Z/);
  assert.match(report.dataQualityNotes.join('\n'), /missing hs_v2_date_entered_1307720553/);
});

'use strict';

const { expect } = require('chai');
const { parseWallboxIds, wallboxObjectId, sessionWindow, summarizeSessions } = require('../lib/wallbox');

describe('wallbox', () => {
  it('parses EVSE IDs from the settings', () => {
    expect(parseWallboxIds(' SE*VOL*E1, SE*VOL*E2;SE*VOL*E1\nX3 ')).to.deep.equal(['SE*VOL*E1', 'SE*VOL*E2', 'X3']);
    expect(parseWallboxIds('')).to.deep.equal([]);
    expect(parseWallboxIds(undefined)).to.deep.equal([]);
  });

  it('builds object IDs without forbidden characters and dots', () => {
    expect(wallboxObjectId('SE*VOL*E12345')).to.equal('SE_VOL_E12345');
    expect(wallboxObjectId('A.B-C', /[*]/g)).to.equal('A_B-C');
  });

  it('builds a session window ending now', () => {
    const w = sessionWindow(Date.parse('2026-11-08T12:00:00Z'), 7);
    expect(w).to.deep.equal({ start: '2026-11-01T12:00:00.000Z', end: '2026-11-08T12:00:00.000Z' });
  });

  it('summarizes charging sessions', () => {
    const s = summarizeSessions([
      { start: '2026-11-01T10:00:00Z', chargedEnergy: 10.5 },
      { start: '2026-11-03T10:00:00Z', chargedEnergy: 7.25 },
      { start: '2026-11-02T10:00:00Z', chargedEnergy: '2' },
    ]);
    expect(s.count).to.equal(3);
    expect(s.totalEnergy).to.equal(19.75);
    expect(s.last.start).to.equal('2026-11-03T10:00:00Z');
    expect(summarizeSessions(null)).to.deep.equal({ count: 0, totalEnergy: 0, last: null });
  });
});

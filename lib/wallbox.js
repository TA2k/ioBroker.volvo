'use strict';

/**
 * EVSE IDs from the adapter settings (comma, semicolon or whitespace separated), without duplicates.
 */
function parseWallboxIds(value) {
  const ids = String(value || '')
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * ioBroker object ID part for an EVSE ID (EVSE IDs may contain characters like "*").
 */
function wallboxObjectId(evseId, forbiddenChars) {
  return String(evseId).replace(forbiddenChars || /[^\w-]/g, '_').replace(/\./g, '_');
}

/**
 * Query window for charging sessions: the last `days` days up to `now`.
 */
function sessionWindow(now, days) {
  const end = new Date(now);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Count, total charged energy and the latest session of a charging session list.
 */
function summarizeSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions.slice() : [];
  list.sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
  const totalEnergy = list.reduce((sum, s) => sum + (Number(s.chargedEnergy) || 0), 0);
  return { count: list.length, totalEnergy: Math.round(totalEnergy * 1000) / 1000, last: list[0] || null };
}

module.exports = { parseWallboxIds, wallboxObjectId, sessionWindow, summarizeSessions };

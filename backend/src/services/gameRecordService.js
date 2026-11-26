'use strict';
const db = require('../db/db');
const { notFound, forbidden } = require('../utils/errors');
const { requireEnum, requireInt } = require('../utils/validate');
const roleNames = { prophet: '先知', watcher: '守望者', companion: '同行者', tempter: '试探者', deceiver: '迷惑者', lurker: '潜伏者', civilian: '平民', undercover: '卧底' };
function archive(room, s, players) {
  if (!s.startedAt || s.phase !== 'finished' || s.recordId) return;
  const game = s.game || 'avalon', finishedAt = new Date().toISOString();
  const summary = { game, roomCode: room.code, startedAt: s.startedAt, finishedAt, winner: s.winner ?? null,
    reason: s.reason || '', status: s.winner == null ? 'abandoned' : 'completed',
    players: players.map(p => ({ ...p,
      ...(s.roles ? { role: roleNames[s.roles[p.id]] } : {}),
      ...(game === 'undercover' ? { word: s.words[p.id], eliminated: s.eliminated.includes(p.id) } : {}),
      ...(game === 'uno' ? { cardCount: s.hands[p.id].length } : {}),
    })),
    ...(game === 'avalon' ? { missions: s.missions, history: s.history } : {}),
    ...(game === 'undercover' ? { clues: s.clues, history: s.history } : {}),
    ...(game === 'uno' ? { events: s.events } : {}),
    ...(game === 'sketch' ? { rounds: s.rounds, scores: s.scores } : {}),
  };
  const result = db.run('INSERT INTO playground_records(host_id,game,finished_at,summary_json) VALUES(?,?,?,?)', room.host_id, game, finishedAt, JSON.stringify(summary));
  s.recordId = result.lastInsertRowid;
  require('./harvestService').party(s.recordId, s, players);
  for (const p of players) db.run('INSERT INTO playground_record_members(record_id,user_id) VALUES(?,?)', s.recordId, p.id);
}
function list(user, query = {}) {
  const game = requireEnum(query.game || 'all', '游戏类型', ['all', 'avalon', 'undercover', 'uno', 'sketch']);
  const page = requireInt(query.page ?? 1, '页码', { min: 1, max: 100000 });
  const where = "m.user_id=? AND (?='all' OR r.game=?)";
  const rows = db.all(`SELECT r.id,r.host_id,r.summary_json FROM playground_records r JOIN playground_record_members m ON m.record_id=r.id WHERE ${where} ORDER BY r.id DESC LIMIT 20 OFFSET ?`, user.id, game, game, (page - 1) * 20);
  return { items: rows.map(row => { const { history, missions, clues, events, ...summary } = JSON.parse(row.summary_json); return { id: row.id, ...summary, canDelete: row.host_id === user.id }; }), page, pageSize: 20,
    total: db.pluck(`SELECT COUNT(*) FROM playground_records r JOIN playground_record_members m ON m.record_id=r.id WHERE ${where}`, user.id, game, game) };
}
function get(id, user) {
  const row = db.get('SELECT r.* FROM playground_records r JOIN playground_record_members m ON m.record_id=r.id WHERE r.id=? AND m.user_id=?', id, user.id);
  if (!row) throw notFound('游戏记录不存在或你未参与');
  return { id: row.id, ...JSON.parse(row.summary_json), reward: require('./harvestService').receipt(user.id, `party:${row.id}`), canDelete: row.host_id === user.id };
}
function remove(id, user) {
  const row = db.get('SELECT r.host_id FROM playground_records r JOIN playground_record_members m ON m.record_id=r.id WHERE r.id=? AND m.user_id=?', id, user.id);
  if (!row) throw notFound('游戏记录不存在或你未参与');
  if (row.host_id !== user.id) throw forbidden('只有本局房主可以删除游戏记录');
  db.run('DELETE FROM playground_records WHERE id=? AND host_id=?', id, user.id);
}
module.exports = { archive, list, get, remove };

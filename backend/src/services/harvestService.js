'use strict';
const db = require('../db/db');
const { forbidden } = require('../utils/errors');
const { requireInt } = require('../utils/validate');
const rewardDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const names = { avalon: '守望之旅', undercover: '同词异心', uno: '彩约对局', sketch: '你画我猜', quiz: '圣经闯关', identity: '我是谁', timeline: '故事时间线', verse: '经文拼图', match: '人物关系连连看', map: '圣经地图寻踪' };
function participant(user) { if (user.role === 'super_admin') throw forbidden('请使用成员或管理员账号参与游乐场'); }
function balance(userId) { return db.pluck(`SELECT (SELECT COALESCE(SUM(amount),0) FROM playground_harvest WHERE user_id=?1) - (SELECT COALESCE(SUM(cost),0) FROM playground_wishes WHERE user_id=?1)`, userId); }
function receipt(userId, sourceKey, noRewardReason = '本局没有禾穗奖励') {
  const entry = db.get('SELECT amount,reason FROM playground_harvest WHERE user_id=? AND source_key=?', userId, sourceKey);
  return { amount: entry?.amount || 0, reason: entry?.reason || noRewardReason, balance: balance(userId) };
}
function credit(userId, sourceKey, game, amount, reason) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) throw new Error('禾穗结算数值无效');
  db.run('INSERT OR IGNORE INTO playground_harvest(user_id,source_key,game,amount,reason,created_at) VALUES(?,?,?,?,?,?)', userId, sourceKey, game, amount, reason, new Date().toISOString());
  return receipt(userId, sourceKey);
}
function party(recordId, state, players) {
  if (state.winner == null) return;
  const game = state.game || 'avalon';
  for (const player of players) {
    const won = game === 'avalon' ? (['prophet', 'watcher', 'companion'].includes(state.roles[player.id]) ? 'light' : 'shadow') === state.winner
      : game === 'undercover' ? state.roles[player.id] === state.winner : game === 'sketch' ? state.winner.includes(player.id) : state.winner === player.id;
    const extra = game === 'sketch' ? Math.floor((state.scores[player.id] || 0) / 100) : 0;
    credit(player.id, `party:${recordId}`, game, 5 + (won ? 10 : 0) + extra, `完成对局 +5${won ? ' · 获胜 +10' : ''}${extra ? ` · 本局表现 +${extra}` : ''}`);
  }
}
function lesson(id, userId, game, results, levelId, levelNumber, completedAt) {
  const day = rewardDate.format(new Date(completedAt));
  const start = new Date(`${day}T00:00:00+08:00`).toISOString();
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  // 完成检查与成绩、奖励写入共用学习操作的事务，按完成时间计入北京时间自然日。
  const completed = db.get(`SELECT 1 FROM playground_lessons WHERE user_id=? AND game=? AND status='completed'
    AND updated_at>=? AND updated_at<? AND json_extract(state_json,'$.levelId')=? AND id<>? LIMIT 1`, userId, game, start, end, levelId, id);
  if (completed) return { amount: 0, reason: '本关今天已完成，今日首次完成才奖励禾穗；本次成绩已记录。', balance: balance(userId) };
  const score = results.reduce((sum, result) => sum + result.score, 0), extra = Math.floor(score / 10), perfect = score === results.length * 10;
  return credit(userId, `lesson:${id}`, game, 2 + extra + (perfect ? 3 : 0), `第 ${levelNumber} 关 · 完成本关 +2 · 本局表现 +${extra}${perfect ? ' · 满分 +3' : ''}`);
}
function list(user, query = {}) {
  participant(user);
  const page = requireInt(query.page ?? 1, '页码', { min: 1, max: 100000 });
  const entries = `SELECT 'earned:' || id AS id,game,amount,reason,created_at AS createdAt,NULL AS topicId FROM playground_harvest WHERE user_id=?1
    UNION ALL SELECT 'wish:' || id,'wish',-cost,title || ' · 已兑换许愿话题',created_at,topic_id FROM playground_wishes WHERE user_id=?1`;
  return { balance: balance(user.id), page, pageSize: 20,
    total: db.pluck(`SELECT COUNT(*) FROM (${entries})`, user.id),
    items: db.all(`SELECT * FROM (${entries}) ORDER BY createdAt DESC,id DESC LIMIT ?2 OFFSET ?3`, user.id, 20, (page - 1) * 20).map(row => ({ ...row, gameName: row.game === 'wish' ? '游乐场许愿' : names[row.game] || row.game })),
  };
}
module.exports = { participant, balance, receipt, party, lesson, list };

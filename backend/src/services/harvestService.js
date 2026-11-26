'use strict';
const db = require('../db/db');
const { forbidden } = require('../utils/errors');
const { requireInt, requireEnum } = require('../utils/validate');
const rewardDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const names = { exercise: '运动打卡', avalon: '守望之旅', undercover: '同词异心', uno: '彩约对局', sketch: '你画我猜', quiz: '圣经闯关', identity: '我是谁', timeline: '故事时间线', verse: '经文拼图', match: '人物关系连连看', map: '圣经地图寻踪' };
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
function exercise(userId, day, currentDay) {
  const key = `exercise:${day}`;
  if (day !== currentDay || db.get('SELECT 1 FROM playground_harvest WHERE user_id=? AND source_key=?', userId, key)) {
    return { amount: 0, reason: day !== currentDay ? '补记不奖励禾穗' : '今天已领取打卡奖励', balance: balance(userId) };
  }
  return credit(userId, key, 'exercise', 2, '今日首次运动打卡 +2');
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
function leaderboard(user, query = {}) {
  participant(user);
  const sort = requireEnum(query.sort ?? 'balance', '排行类型', ['balance', 'wishes']);
  const page = requireInt(query.page ?? 1, '页码', { min: 1, max: 100000 });
  const ranked = `WITH earned AS (
    SELECT user_id,SUM(amount) AS amount FROM playground_harvest GROUP BY user_id
  ), wishes AS (
    SELECT user_id,COUNT(*) AS count,SUM(cost) AS spent FROM playground_wishes GROUP BY user_id
  ), totals AS (
    SELECT u.id,u.display_name AS name,COALESCE(earned.amount,0)-COALESCE(wishes.spent,0) AS balance,
      COALESCE(wishes.count,0) AS wishCount
    FROM users u LEFT JOIN earned ON earned.user_id=u.id LEFT JOIN wishes ON wishes.user_id=u.id
    WHERE u.status='active' AND u.role IN ('employee','admin')
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER (ORDER BY ${sort === 'wishes' ? 'wishCount' : 'balance'} DESC,id) AS rank FROM totals
  )`;
  return { sort, page, pageSize: 20,
    total: db.pluck(`${ranked} SELECT COUNT(*) FROM ranked`),
    me: db.get(`${ranked} SELECT * FROM ranked WHERE id=?`, user.id) || null,
    items: db.all(`${ranked} SELECT * FROM ranked ORDER BY rank LIMIT ? OFFSET ?`, 20, (page - 1) * 20),
  };
}
module.exports = { participant, balance, receipt, party, lesson, exercise, list, leaderboard };

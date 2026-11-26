'use strict';
const { randomInt } = require('node:crypto');
const { badRequest, forbidden, conflict } = require('../utils/errors');
const { requireInt, requireString } = require('../utils/validate');

// Original word pairs, kept server-side so opening the client bundle cannot reveal the other word.
const pairs = [
  ['摩西', '亚伦'], ['彼得', '约翰'], ['马大', '马利亚'], ['大卫', '所罗门'], ['以利亚', '以利沙'],
  ['撒母耳', '拿单'], ['亚伯拉罕', '以撒'], ['雅各', '约瑟'], ['路得', '以斯帖'], ['约书亚', '迦勒'],
  ['伯利恒', '拿撒勒'], ['耶路撒冷', '耶利哥'], ['加利利海', '约旦河'], ['橄榄山', '西奈山'],
  ['方舟', '会幕'], ['吗哪', '鹌鹑'], ['五饼二鱼', '水变酒'], ['葡萄树', '橄榄树'],
  ['牧羊人', '渔夫'], ['牧杖', '弹弓'], ['灯台', '香坛'], ['无花果', '石榴'],
];
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
function phase(s, value) { s.phase = value; s.turn++; }
function startDescription(s, ids, runoff = false) {
  s.runoff = runoff; s.order = shuffle([...ids]); s.spoken = []; s.votes = {};
  if (!runoff) s.candidates = [...ids];
  phase(s, 'describe');
}
const changed = () => conflict('GAME_CHANGED', '房间进度已变化，请同步后重试');
function act(s, action, body, user, players, host) {
  const ids = players.map(p => p.id), alive = ids.filter(id => !s.eliminated?.includes(id));
  if (action === 'start') {
    if (!host) throw forbidden('只有房主可以开始游戏');
    if (s.phase !== 'waiting') throw changed();
    if (ids.length < 4 || ids.length > 10) throw badRequest('需要四至十位玩家');
    if (!ids.every(id => s.ready[id])) throw badRequest('请等待所有成员准备');
    const count = ids.length >= 7 ? 2 : 1, roles = shuffle([...Array(count).fill('undercover'), ...Array(ids.length - count).fill('civilian')]);
    const pair = shuffle([...pairs[randomInt(pairs.length)]]);
    s.roles = Object.fromEntries(ids.map((id, i) => [id, roles[i]]));
    s.words = Object.fromEntries(ids.map(id => [id, pair[s.roles[id] === 'undercover' ? 1 : 0]]));
    s.round = 1; s.ack = {}; s.eliminated = []; s.clues = []; s.history = []; s.votes = {}; s.runoff = false;
    phase(s, 'identity');
  } else if (action === 'acknowledge') {
    if (s.phase !== 'identity') throw changed();
    s.ack[user.id] = true;
    if (ids.every(id => s.ack[id])) startDescription(s, ids);
  } else if (action === 'speak') {
    if (s.phase !== 'describe') throw changed();
    if (s.order[s.spoken.length] !== user.id) throw forbidden('请等待轮到你描述');
    const text = requireString(body.text ?? '', '描述', { min: 0, max: 120 });
    if (text.includes(s.words[user.id])) throw badRequest('描述中请不要直接出现自己的词语');
    s.clues.push({ round: s.round, userId: user.id, text: text || '已完成口头描述', runoff: s.runoff });
    s.spoken.push(user.id);
    if (s.spoken.length === s.order.length) { s.votes = {}; phase(s, 'vote'); }
    else s.turn++;
  } else if (action === 'votePlayer') {
    if (s.phase !== 'vote') throw changed();
    if (!alive.includes(user.id)) throw forbidden('已出局的玩家不能投票');
    if (Object.hasOwn(s.votes, user.id)) throw conflict('ALREADY_SUBMITTED', '已投票，不能修改');
    const targetId = requireInt(body.targetId, '投票对象', { min: 1 });
    if (targetId === user.id || !s.candidates.includes(targetId) || !alive.includes(targetId)) throw badRequest('请选择仍在场的其他候选成员');
    s.votes[user.id] = targetId;
    if (alive.every(id => Object.hasOwn(s.votes, id))) {
      const counts = Object.values(s.votes).reduce((map, id) => ({ ...map, [id]: (map[id] || 0) + 1 }), {});
      const maximum = Math.max(...Object.values(counts)), tied = Object.keys(counts).map(Number).filter(id => counts[id] === maximum);
      const eliminatedId = tied.length === 1 ? tied[0] : null;
      s.history.push({ round: s.round, runoff: s.runoff, votes: { ...s.votes }, counts, tied, eliminatedId });
      if (eliminatedId) s.eliminated.push(eliminatedId);
      const remaining = alive.filter(id => id !== eliminatedId), bad = remaining.filter(id => s.roles[id] === 'undercover').length;
      if (bad === 0 || remaining.length - bad <= bad) {
        s.winner = bad === 0 ? 'civilian' : 'undercover'; s.reason = bad === 0 ? '所有卧底均已出局。' : '卧底人数已不少于平民人数。'; phase(s, 'finished');
      } else phase(s, 'voteResult');
    }
  } else if (action === 'advance') {
    if (s.phase !== 'voteResult') throw changed();
    const last = s.history.at(-1);
    if (!last.eliminatedId && !s.runoff) {
      s.candidates = last.tied; startDescription(s, last.tied, true);
    } else { s.round++; startDescription(s, alive); }
  } else throw badRequest('当前游戏不支持此操作');
}
function present(room, s, players, user) {
  const finished = s.phase === 'finished', me = players.find(p => p.id === user.id);
  return { game: 'undercover', id: room.id, code: room.code, hostId: room.host_id, revision: room.revision, phase: s.phase, turn: s.turn,
    players: players.map(p => ({ ...p, ready: !!s.ready?.[p.id], acknowledged: !!s.ack?.[p.id], eliminated: !!s.eliminated?.includes(p.id), voted: Object.hasOwn(s.votes || {}, p.id),
      ...((finished || s.eliminated?.includes(p.id)) && s.roles ? { role: s.roles[p.id] } : {}), ...(finished && s.words ? { word: s.words[p.id] } : {}) })),
    me: { ...me, word: s.words?.[user.id] ?? null, vote: s.votes?.[user.id] ?? null, eliminated: !!s.eliminated?.includes(user.id) },
    round: s.round || 1, runoff: !!s.runoff, order: s.order || [], spoken: s.spoken || [], speakerId: s.phase === 'describe' ? s.order[s.spoken.length] : null,
    candidates: s.candidates || [], clues: s.clues || [], history: s.history || [], winner: s.winner ?? null, reason: s.reason ?? null,
    undercoverCount: players.length >= 7 ? 2 : 1,
  };
}
module.exports = { act, present };

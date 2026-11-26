'use strict';
const { randomInt } = require('node:crypto');
const db = require('../db/db');
const { badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const { requireArray, requireInt, requireBoolean, requireString, requireEnum } = require('../utils/validate');
const undercover = require('./undercoverService');
const uno = require('./unoService');
const sketch = require('./sketchService');
const { archive } = require('./gameRecordService');

const GOOD_COUNTS = { 5: 3, 6: 4, 7: 4, 8: 5, 9: 6, 10: 6 };
const TEAM_SIZES = { 5: [2, 3, 2, 3, 3], 6: [2, 3, 4, 3, 4], 7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5], 9: [3, 4, 4, 5, 5], 10: [3, 4, 4, 5, 5] };
const ROLES = {
  prophet: { name: '先知', side: 'light', description: '知道所有暗影成员，帮助使命成功，同时保护自己的身份。' },
  watcher: { name: '守望者', side: 'light', description: '看到先知与迷惑者两位候选，但不知道谁是真正的先知。' },
  companion: { name: '同行者', side: 'light', description: '通过讨论与投票找出可信赖的同伴，完成三次使命。' },
  tempter: { name: '试探者', side: 'shadow', description: '可暗中破坏使命；光明完成三次使命后，由你指认先知。' },
  deceiver: { name: '迷惑者', side: 'shadow', description: '在守望者眼中与先知难以区分，可暗中破坏使命。' },
  lurker: { name: '潜伏者', side: 'shadow', description: '与暗影同伴配合，可选择支持或破坏使命。' },
};
const stale = () => conflict('GAME_CHANGED', '房间进度已变化，请同步后重试');
function participant(user) {
  if (user.role === 'super_admin') throw forbidden('请使用成员或管理员账号参与游乐场');
}
function cleanExpired() {
  db.tx(() => {
    const expired = db.all('SELECT * FROM playground_rooms WHERE updated_at<?', new Date(Date.now() - 24 * 3600000).toISOString());
    for (const room of expired) {
      const s = JSON.parse(room.state_json);
      if (!['waiting', 'finished'].includes(s.phase)) finish(s, null, '房间长时间无操作，本局提前结束。');
      archive(room, s, players(room.id));
      db.run('DELETE FROM playground_rooms WHERE id=?', room.id);
    }
  });
}
function row(id, user) {
  participant(user);
  const room = db.get(`SELECT r.* FROM playground_rooms r JOIN playground_members m ON m.room_id=r.id WHERE r.id=? AND m.user_id=?`, id, user.id);
  if (!room) throw notFound('房间已结束或你尚未加入');
  return room;
}
function save(room, state) {
  db.run('UPDATE playground_rooms SET state_json=?,revision=revision+1,updated_at=? WHERE id=?', JSON.stringify(state), new Date().toISOString(), room.id);
}
function players(id) {
  return db.all(`SELECT u.id,u.display_name AS name FROM playground_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.rowid`, id);
}
function side(role) { return ROLES[role].side; }
function phase(state, next) { state.phase = next; state.turn++; }
function finish(state, winner, reason) { state.winner = winner; state.reason = reason; phase(state, 'finished'); }
function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}

function present(room, user) {
  const view = presentGame(room, user);
  const s = JSON.parse(room.state_json);
  if (view.phase === 'finished' && s.recordId) view.reward = require('./harvestService').receipt(user.id, `party:${s.recordId}`);
  return view;
}
function presentGame(room, user) {
  const s = JSON.parse(room.state_json);
  const list = players(room.id);
  if (s.game === 'undercover') return undercover.present(room, s, list, user);
  if (s.game === 'uno') return uno.present(room, s, list, user);
  if (s.game === 'sketch') return sketch.present(room, s, list, user);
  const me = list.find(p => p.id === user.id);
  const role = s.roles?.[user.id];
  let knowledge = [];
  if (role === 'prophet' || (role && side(role) === 'shadow')) knowledge = list.filter(p => p.id !== user.id && side(s.roles[p.id]) === 'shadow').map(p => p.id);
  if (role === 'watcher') knowledge = list.filter(p => ['prophet', 'deceiver'].includes(s.roles[p.id])).map(p => p.id);
  // Never serialize state wholesale: hidden roles, partial votes and individual mission cards stay server-side.
  return { game: 'avalon', id: room.id, code: room.code, hostId: room.host_id, revision: room.revision, phase: s.phase, turn: s.turn,
    players: list.map(p => ({ ...p, ready: !!s.ready?.[p.id], acknowledged: !!s.ack?.[p.id],
      voted: Object.hasOwn(s.votes || {}, p.id), submitted: Object.hasOwn(s.cards || {}, p.id),
      ...(s.phase === 'finished' && s.roles ? { role: ROLES[s.roles[p.id]] } : {}) })),
    me: { ...me, ...(role ? { role: { ...ROLES[role], code: role }, knowledge } : {}),
      vote: s.votes?.[user.id] ?? null, submitted: Object.hasOwn(s.cards || {}, user.id) },
    round: s.round ?? 0, leaderId: s.leaderId ?? null, team: s.team || [], rejected: s.rejected || 0,
    teamSizes: TEAM_SIZES[list.length] || [], failThreshold: list.length >= 7 && s.round === 3 ? 2 : 1,
    history: s.history || [], missions: s.missions || [], winner: s.winner ?? null, reason: s.reason ?? null,
  };
}
function get(id, user) { return present(row(id, user), user); }
function current(user) {
  participant(user); cleanExpired();
  const room = db.get('SELECT r.* FROM playground_rooms r JOIN playground_members m ON m.room_id=r.id WHERE m.user_id=?', user.id);
  return room ? present(room, user) : null;
}
function create(user, game = 'avalon') {
  participant(user);
  requireEnum(game, '游戏', ['avalon', 'undercover', 'uno', 'sketch']);
  return db.tx(() => {
    if (current(user)) throw conflict('ALREADY_IN_ROOM', '你已在一个房间中，请先退出');
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (db.get('SELECT id FROM playground_rooms WHERE code=?', code));
    const state = { game, phase: 'waiting', turn: 0, ready: {} };
    const { lastInsertRowid: id } = db.run('INSERT INTO playground_rooms(code,host_id,state_json,updated_at) VALUES(?,?,?,?)', code, user.id, JSON.stringify(state), new Date().toISOString());
    db.run('INSERT INTO playground_members(room_id,user_id) VALUES(?,?)', id, user.id);
    return get(id, user);
  });
}
function join(value, user) {
  participant(user);
  const code = requireString(value, '房间号', { min: 6, max: 6 });
  if (!/^\d{6}$/.test(code)) throw badRequest('请输入六位数字房间号');
  return db.tx(() => {
    const previous = current(user);
    if (previous) {
      if (previous.code === code) return previous;
      throw conflict('ALREADY_IN_ROOM', '你已在另一个房间中，请先退出');
    }
    const room = db.get('SELECT * FROM playground_rooms WHERE code=?', code);
    if (!room) throw notFound('房间不存在或已过期');
    const state = JSON.parse(room.state_json);
    if (state.phase !== 'waiting') throw conflict('GAME_STARTED', '游戏已开始，暂时不能加入');
    if (players(room.id).length >= 10) throw conflict('ROOM_FULL', '房间已满，最多十人');
    db.run('INSERT INTO playground_members(room_id,user_id) VALUES(?,?)', room.id, user.id);
    save(room, state);
    return get(room.id, user);
  });
}
function act(id, body, user) {
  return db.tx(() => {
    const room = row(id, user), s = JSON.parse(room.state_json), list = players(id), ids = list.map(p => p.id);
    const action = requireEnum(body.action, '操作', ['ready', 'start', 'acknowledge', 'team', 'vote', 'mission', 'advance', 'accuse', 'restart', 'leave', 'speak', 'votePlayer', 'playCard', 'draw', 'pass', 'stroke', 'clearCanvas', 'undoStroke', 'describeDrawing', 'guessDrawing']);
    const host = room.host_id === user.id;
    if (action === 'leave') {
      if (host) {
        if (!['waiting', 'finished'].includes(s.phase)) finish(s, null, '房主解散了房间，本局提前结束。');
        archive(room, s, list);
        db.run('DELETE FROM playground_rooms WHERE id=?', id);
      }
      else {
        db.run('DELETE FROM playground_members WHERE room_id=? AND user_id=?', id, user.id);
        if (!['waiting', 'finished'].includes(s.phase)) finish(s, null, '有成员离开，本局已结束，可由房主重新开始。');
        archive(room, s, list);
        delete s.ready?.[user.id]; save(room, s);
      }
      return null;
    }
    if (requireInt(body.turn, '进度编号', { min: 0 }) !== s.turn) throw stale();
    if (action === 'restart') {
      if (!host) throw forbidden('只有房主可以重新开始');
      if (s.phase !== 'finished') throw badRequest('请先结束当前游戏');
      save(room, { game: s.game || 'avalon', phase: 'waiting', turn: s.turn + 1, ready: {} });
      return get(id, user);
    } else if (action === 'ready') {
      if (s.phase !== 'waiting') throw stale();
      s.ready[user.id] = requireBoolean(body.ready, '准备状态');
    } else if (s.game === 'undercover') {
      undercover.act(s, action, body, user, list, host);
    } else if (s.game === 'uno') {
      uno.act(s, action, body, user, list, host);
    } else if (s.game === 'sketch') {
      sketch.act(s, action, body, user, list, host);
    } else if (action === 'start') {
      if (!host) throw forbidden('只有房主可以开始游戏');
      if (s.phase !== 'waiting') throw stale();
      if (ids.length < 5 || ids.length > 10) throw badRequest('需要五至十位玩家');
      if (!ids.every(uid => s.ready[uid])) throw badRequest('请等待所有成员准备');
      const good = GOOD_COUNTS[ids.length];
      const roles = shuffle(['prophet', 'watcher', ...Array(good - 2).fill('companion'), 'tempter', 'deceiver', ...Array(ids.length - good - 2).fill('lurker')]);
      s.roles = Object.fromEntries(ids.map((uid, i) => [uid, roles[i]]));
      s.round = 0; s.leaderId = ids[randomInt(ids.length)]; s.ack = {}; s.team = []; s.votes = {}; s.cards = {}; s.rejected = 0; s.history = []; s.missions = [];
      phase(s, 'identity');
    } else if (action === 'acknowledge') {
      if (s.phase !== 'identity') throw stale();
      s.ack[user.id] = true;
      if (ids.every(uid => s.ack[uid])) phase(s, 'team');
    } else if (action === 'team') {
      if (s.phase !== 'team') throw stale();
      if (s.leaderId !== user.id) throw forbidden('请由本轮队长选择成员');
      const team = requireArray(body.team, '队伍', { min: 1, max: 5 });
      if (team.length !== TEAM_SIZES[ids.length][s.round] || new Set(team).size !== team.length || !team.every(uid => Number.isInteger(uid) && ids.includes(uid))) throw badRequest('请选择正确人数且不重复的房间成员');
      s.team = team; s.votes = {}; phase(s, 'vote');
    } else if (action === 'vote' || action === 'mission') {
      if (s.phase !== action) throw stale();
      const value = requireBoolean(body.value, action === 'vote' ? '投票' : '任务牌');
      const store = action === 'vote' ? s.votes : s.cards;
      if (Object.hasOwn(store, user.id)) throw conflict('ALREADY_SUBMITTED', '已提交，不能修改');
      if (action === 'mission') {
        if (!s.team.includes(user.id)) throw forbidden('只有本次队员可以提交任务牌');
        if (value === false && side(s.roles[user.id]) === 'light') throw forbidden('光明阵营只能提交支持');
      }
      store[user.id] = value;
      const voters = action === 'vote' ? ids : s.team;
      if (voters.every(uid => Object.hasOwn(store, uid))) {
        if (action === 'vote') {
          const approved = Object.values(store).filter(Boolean).length > ids.length / 2;
          s.history.push({ round: s.round, leaderId: s.leaderId, team: s.team, votes: { ...store }, approved });
          if (!approved) s.rejected++;
          if (s.rejected === 5) finish(s, 'shadow', '连续五次组队未通过。');
          else phase(s, 'voteResult');
        } else {
          const fails = Object.values(store).filter(v => !v).length;
          s.missions.push({ team: s.team, fails, success: fails < (ids.length >= 7 && s.round === 3 ? 2 : 1) });
          s.cards = {}; phase(s, 'missionResult');
        }
      }
    } else if (action === 'advance') {
      if (s.phase === 'voteResult') {
        if (s.history.at(-1).approved) { s.rejected = 0; s.cards = {}; phase(s, 'mission'); }
        else { s.team = []; s.votes = {}; s.leaderId = ids[(ids.indexOf(s.leaderId) + 1) % ids.length]; phase(s, 'team'); }
      } else if (s.phase === 'missionResult') {
        const successes = s.missions.filter(m => m.success).length;
        if (s.missions.length - successes >= 3) finish(s, 'shadow', '三次使命失败。');
        else if (successes >= 3) phase(s, 'accusation');
        else { s.round++; s.team = []; s.votes = {}; s.leaderId = ids[(ids.indexOf(s.leaderId) + 1) % ids.length]; phase(s, 'team'); }
      } else throw stale();
    } else if (action === 'accuse') {
      if (s.phase !== 'accusation') throw stale();
      if (s.roles[user.id] !== 'tempter') throw forbidden('请由试探者进行最终指认');
      const target = requireInt(body.targetId, '指认成员', { min: 1 });
      if (!ids.includes(target) || side(s.roles[target]) !== 'light') throw badRequest('请选择一位光明阵营成员');
      finish(s, s.roles[target] === 'prophet' ? 'shadow' : 'light', `试探者指认了${list.find(p => p.id === target).name}，${s.roles[target] === 'prophet' ? '找到了先知' : '未找到先知'}。`);
    } else throw badRequest('当前游戏不支持此操作');
    if (action === 'start') s.startedAt = new Date().toISOString();
    archive(room, s, list);
    save(room, s);
    return get(id, user);
  });
}
module.exports = { create, join, current, get, act };

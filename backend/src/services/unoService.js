'use strict';
const { randomInt } = require('node:crypto');
const { badRequest, forbidden, conflict } = require('../utils/errors');
const { requireString, requireEnum } = require('../utils/validate');
const COLORS = ['purple', 'gold', 'green', 'blue'];
const COLOR_NAMES = { purple: '葡萄紫', gold: '麦穗金', green: '橄榄绿', blue: '溪水蓝', wild: '彩约' };
const LABELS = { skip: '安息 · 跳过', reverse: '回转 · 反转', draw2: '同行 · +2', wild: '彩约 · 换色', draw4: '四方 · +4' };
function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) { const j = randomInt(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
}
function deck() {
  const cards = [];
  for (const color of COLORS) {
    for (let n = 0; n <= 9; n++) for (let copy = 0; copy < (n === 0 ? 1 : 2); copy++) cards.push({ id: `${color}-${n}-${copy}`, color, kind: 'number', value: n, label: String(n) });
    for (const kind of ['skip', 'reverse', 'draw2']) for (let copy = 0; copy < 2; copy++) cards.push({ id: `${color}-${kind}-${copy}`, color, kind, label: LABELS[kind] });
  }
  for (const kind of ['wild', 'draw4']) for (let copy = 0; copy < 4; copy++) cards.push({ id: `${kind}-${copy}`, color: 'wild', kind, label: LABELS[kind] });
  return shuffle(cards);
}
function playable(s, card, hand) {
  if (card.kind === 'draw4') return !hand.some(c => c.color === s.color);
  const top = s.discard.at(-1);
  return card.color === 'wild' || card.color === s.color || (card.kind === 'number' && top.kind === 'number' ? card.value === top.value : card.kind !== 'number' && card.kind === top.kind);
}
function take(s, id, count) {
  const result = [];
  while (result.length < count) {
    if (!s.deck.length) {
      if (s.discard.length <= 1) break;
      const top = s.discard.pop(); s.deck = shuffle(s.discard); s.discard = [top];
    }
    const card = s.deck.pop(); s.hands[id].push(card); result.push(card);
  }
  return result;
}
function act(s, action, body, user, players, host) {
  const ids = players.map(p => p.id);
  const next = (id, steps = 1) => ids[(ids.indexOf(id) + s.direction * steps + ids.length * 2) % ids.length];
  const log = text => { s.events.push(text); s.events = s.events.slice(-500); };
  const advance = (steps = 1) => { s.currentId = next(user.id, steps); s.drawnId = null; s.turn++; };
  if (action === 'start') {
    if (!host) throw forbidden('只有房主可以开始游戏');
    if (s.phase !== 'waiting') throw conflict('GAME_CHANGED', '房间进度已变化');
    if (ids.length < 2 || ids.length > 10) throw badRequest('需要二至十位玩家');
    if (!ids.every(id => s.ready[id])) throw badRequest('请等待所有成员准备');
    s.deck = deck(); s.hands = Object.fromEntries(ids.map(id => [id, []])); s.discard = [];
    for (let i = 0; i < 7; i++) for (const id of ids) s.hands[id].push(s.deck.pop());
    const openingIndex = s.deck.findIndex(card => card.kind === 'number');
    s.discard = s.deck.splice(openingIndex, 1); s.color = s.discard[0].color;
    s.direction = 1; s.currentId = ids[randomInt(ids.length)]; s.drawnId = null; s.events = []; s.phase = 'playing'; s.turn++;
    log('每人七张牌，旅程开始。'); return;
  }
  if (s.phase !== 'playing') throw conflict('GAME_CHANGED', '房间进度已变化');
  if (s.currentId !== user.id) throw forbidden('请等待轮到你出牌');
  const hand = s.hands[user.id], actor = players.find(p => p.id === user.id).name;
  if (action === 'draw') {
    if (s.drawnId) throw badRequest('本回合已经抽过牌，请出牌或结束回合');
    const [card] = take(s, user.id, 1); log(`${actor}抽了一张牌。`);
    if (card && playable(s, card, hand)) { s.drawnId = card.id; s.turn++; }
    else advance();
  } else if (action === 'pass') {
    if (!s.drawnId) throw badRequest('请先抽一张牌');
    log(`${actor}结束回合。`); advance();
  } else if (action === 'playCard') {
    const cardId = requireString(body.cardId, '手牌编号', { max: 50 }), index = hand.findIndex(card => card.id === cardId), card = hand[index];
    if (!card || (s.drawnId && s.drawnId !== card.id)) throw badRequest('请选择本回合可出的自己的手牌');
    if (!playable(s, card, hand)) throw badRequest('这张牌不符合当前颜色、数字或功能；加四要求没有同色手牌');
    const color = card.color === 'wild' ? requireEnum(body.color, '下一种颜色', COLORS) : card.color;
    hand.splice(index, 1); s.discard.push(card); s.color = color;
    let steps = 1;
    if (card.kind === 'reverse') { s.direction *= -1; if (ids.length === 2) steps = 2; }
    if (card.kind === 'skip') steps = 2;
    if (card.kind === 'draw2' || card.kind === 'draw4') { take(s, next(user.id), card.kind === 'draw2' ? 2 : 4); steps = 2; }
    log(`${actor}打出${COLOR_NAMES[card.color]} ${card.label}${card.color === 'wild' ? `，选择${COLOR_NAMES[color]}` : ''}。`);
    if (hand.length === 1) {
      if (body.uno === true) log(`${actor}：UNO！`);
      else { take(s, user.id, 2); log(`${actor}忘记喊 UNO，补两张牌。`); }
    }
    if (hand.length === 0) { s.winner = user.id; s.reason = `${actor}率先出完所有手牌。`; s.phase = 'finished'; s.turn++; s.drawnId = null; }
    else advance(steps);
  } else throw badRequest('当前游戏不支持此操作');
}
function present(room, s, players, user) {
  const myTurn = s.phase === 'playing' && s.currentId === user.id, hand = s.hands?.[user.id] || [];
  return { game: 'uno', id: room.id, code: room.code, hostId: room.host_id, revision: room.revision, phase: s.phase, turn: s.turn,
    players: players.map(p => ({ ...p, ready: !!s.ready?.[p.id], cardCount: s.hands?.[p.id]?.length || 0 })),
    me: { id: user.id, hand: hand.map(card => ({ ...card, playable: myTurn && (!s.drawnId || s.drawnId === card.id) && playable(s, card, hand) })) },
    currentId: s.currentId ?? null, direction: s.direction || 1, top: s.discard?.at(-1) || null, color: s.color || null,
    drawn: myTurn && !!s.drawnId, drawCount: s.deck?.length || 0, events: s.events || [], winner: s.winner ?? null, reason: s.reason ?? null,
  };
}
module.exports = { act, present };

'use strict';
const { randomInt } = require('node:crypto');
const { badRequest, forbidden, conflict } = require('../utils/errors');
const { requireString, requireEnum, requireInt, requireArray } = require('../utils/validate');
const prompts = [
  ['挪亚方舟', ['方舟'], '创世记 6:14–22', 'GEN06'],
  ['彩虹', ['虹'], '创世记 9:12–17', 'GEN09'],
  ['燃烧的荆棘', ['荆棘', '焚而不毁的荆棘'], '出埃及记 3:1–6', 'EXO03'],
  ['红海', ['过红海', '分开红海'], '出埃及记 14:21–29', 'EXO14'],
  ['吗哪', [], '出埃及记 16:14–18', 'EXO16'],
  ['十诫', ['十诫石版', '石版'], '出埃及记 31:18；34:28', 'EXO34'],
  ['约柜', [], '出埃及记 25:10–22', 'EXO25'],
  ['机弦', ['甩石器', '投石索'], '撒母耳记上 17:40–50', '1SA17'],
  ['狮子坑', ['但以理的狮子坑'], '但以理书 6:16–23', 'DAN06'],
  ['大鱼', ['约拿的大鱼', '鱼'], '约拿书 1:17；2:1', 'JON02'],
  ['马槽', [], '路加福音 2:7', 'LUK02'],
  ['桑树', ['撒该的桑树'], '路加福音 19:1–10', 'LUK19'],
  ['五饼二鱼', ['五饼两鱼', '五个饼两条鱼'], '约翰福音 6:5–13', 'JHN06'],
  ['迷失的羊', ['迷羊', '失羊'], '路加福音 15:3–7', 'LUK15'],
  ['芥菜种', ['芥菜种子'], '马太福音 13:31–32', 'MAT13'],
  ['撒种', ['撒种的比喻', '撒种的人'], '马太福音 13:3–9', 'MAT13'],
  ['渔网', ['鱼网', '网鱼'], '马太福音 13:47–50', 'MAT13'],
  ['灯台', [], '马太福音 5:14–16', 'MAT05'],
];
const colors = ['#24344d', '#3159aa', '#e05656', '#33925c', '#d99826'];
const normalize = value => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function phase(s, name) { s.phase = name; s.turn++; }
function newRound(s) {
  s.promptIndex = s.prompts[s.round]; s.drawerId = s.order[s.round];
  s.strokes = []; s.guesses = []; s.correct = []; s.description = ''; phase(s, 'drawing');
}
function reveal(s) {
  const [answer, , ref, chapter] = prompts[s.promptIndex];
  s.rounds.push({ round: s.round + 1, drawerId: s.drawerId, answer, ref, url: `https://ebible.org/cmn-cu89s/${chapter}.htm`, correct: [...s.correct] });
  phase(s, 'drawingResult');
}
function present(room, s, players, user) {
  const revealAnswer = ['drawingResult', 'finished'].includes(s.phase), mine = s.drawerId === user.id;
  return { game: 'sketch', id: room.id, code: room.code, hostId: room.host_id, revision: room.revision, phase: s.phase, turn: s.turn,
    players: players.map(p => ({ ...p, ready: !!s.ready[p.id], score: s.scores?.[p.id] || 0, guessed: s.correct?.includes(p.id) || false })),
    me: { id: user.id, guessed: s.correct?.includes(user.id) || false }, round: (s.round ?? 0) + 1,
    drawerId: s.drawerId, strokes: s.strokes || [], description: s.description || '',
    guesses: (s.guesses || []).map(g => ({ userId: g.userId, correct: g.correct, text: g.correct && !revealAnswer ? '猜对了！' : g.text })),
    ...(s.promptIndex != null && (mine || revealAnswer) ? { answer: prompts[s.promptIndex][0] } : {}),
    rounds: s.rounds || [], winner: s.winner ?? null, reason: s.reason || '',
  };
}
function act(s, action, body, user, players, host) {
  const ids = players.map(p => p.id), drawer = s.drawerId === user.id;
  if (action === 'start') {
    if (!host) throw forbidden('只有房主可以开始游戏');
    if (s.phase !== 'waiting') throw conflict('GAME_CHANGED', '请同步房间后重试');
    if (ids.length < 2 || ids.length > 10) throw badRequest('需要二至十位玩家');
    if (!ids.every(id => s.ready[id])) throw badRequest('请等待所有人准备');
    s.order = [...ids]; s.round = 0; s.rounds = []; s.scores = Object.fromEntries(ids.map(id => [id, 0]));
    const pool = prompts.map((_, i) => i); s.prompts = [];
    while (s.prompts.length < ids.length) s.prompts.push(pool.splice(randomInt(pool.length), 1)[0]);
    newRound(s); return;
  }
  if (action === 'advance') {
    if (!host && !drawer) throw forbidden('请由绘画者或房主推进');
    if (s.phase === 'drawing') { reveal(s); return; }
    if (s.phase !== 'drawingResult') throw badRequest('当前不能进入下一轮');
    if (++s.round === s.order.length) {
      const maximum = Math.max(...Object.values(s.scores));
      s.winner = ids.filter(id => s.scores[id] === maximum); s.reason = '每人完成一轮绘画，按总分结算；同分并列。'; phase(s, 'finished');
    } else newRound(s);
    return;
  }
  if (s.phase !== 'drawing') throw conflict('GAME_CHANGED', '当前不在绘画阶段');
  if (['stroke', 'clearCanvas', 'undoStroke', 'describeDrawing'].includes(action)) {
    if (!drawer) throw forbidden('只有本轮绘画者可以操作画布');
    if (action === 'stroke') {
      if (s.strokes.length >= 200) throw badRequest('最多 200 笔，可撤销或清空后继续');
      const color = requireEnum(body.color, '颜色', colors), width = requireInt(body.width, '笔宽', { min: 1, max: 12 });
      const points = requireArray(body.points, '笔迹', { min: 1, max: 200 });
      if (!points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) throw badRequest('笔迹坐标无效');
      s.strokes.push({ color, width, points });
    } else if (action === 'clearCanvas') s.strokes = [];
    else if (action === 'undoStroke') s.strokes.pop();
    else {
      const text = requireString(body.text, '文字描述', { min: 1, max: 120 }), normalized = normalize(text);
      if ([prompts[s.promptIndex][0], ...prompts[s.promptIndex][1]].some(word => normalized.includes(normalize(word)))) throw badRequest('请不要直接写出答案或别称');
      s.description = text;
    }
  } else if (action === 'guessDrawing') {
    if (drawer) throw forbidden('绘画者不能猜自己的题');
    if (s.correct.includes(user.id)) throw conflict('ALREADY_SUBMITTED', '你已猜对，请等待其他人');
    if (s.guesses.filter(g => g.userId === user.id).length >= 10) throw badRequest('每轮最多猜十次，请等待揭晓');
    const text = requireString(body.text, '答案', { min: 1, max: 30 });
    const correct = [prompts[s.promptIndex][0], ...prompts[s.promptIndex][1]].some(word => normalize(word) === normalize(text));
    s.guesses.push({ userId: user.id, text, correct });
    if (correct) {
      s.scores[user.id] += Math.max(20, 100 - s.correct.length * 20); s.scores[s.drawerId] += 30; s.correct.push(user.id);
      if (s.correct.length === ids.length - 1) reveal(s);
    }
  } else throw badRequest('当前游戏不支持此操作');
}
module.exports = { act, present, prompts };

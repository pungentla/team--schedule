'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo');
const game = require('../src/services/partyService');
const records = require('../src/services/gameRecordService');
let users;
test.before(() => { db.open(':memory:'); migrate(); });
test.beforeEach(() => { truncateAll(); users = Array.from({ length: 10 }, (_, i) => ({ id: insertUser({ employeeNo: `P${i}`, name: `玩家${i}`, passwordHash: 'fixture' }), role: 'employee' })); });
test.after(() => db.close());
const view = (r, u = users[0]) => game.get(r.id, u);
const act = (r, action, body = {}, u = users[0]) => game.act(r.id, { action, turn: view(r, u).turn, ...body }, u);
const raw = r => JSON.parse(db.get('SELECT state_json FROM playground_rooms WHERE id=?', r.id).state_json);
const put = (r, s) => db.run('UPDATE playground_rooms SET state_json=? WHERE id=?', JSON.stringify(s), r.id);
function setup(kind, count) {
  const r = game.create(users[0], kind);
  users.slice(1, count).forEach(u => game.join(r.code, u));
  users.slice(0, count).forEach(u => act(r, 'ready', { ready: true }, u)); act(r, 'start');
  if (kind === 'undercover') users.slice(0, count).forEach(u => act(r, 'acknowledge', {}, u));
  return view(r);
}
function describeAll(r) {
  while (view(r).phase === 'describe') { const current = view(r); act(r, 'speak', { text: '这是我的一句描述' }, users.find(u => u.id === current.speakerId)); }
}
function eliminate(r, id) {
  describeAll(r); const alive = view(r).players.filter(p => !p.eliminated);
  for (const player of alive) act(r, 'votePlayer', { targetId: player.id === id ? alive.find(p => p.id !== id).id : id }, users.find(u => u.id === player.id));
}
test('卧底人数配比、词语与角色保密，跨游戏不能重复建房', () => {
  for (const count of [4, 7, 10]) {
    const r = setup('undercover', count), s = raw(r);
    assert.equal(Object.values(s.roles).filter(v => v === 'undercover').length, count >= 7 ? 2 : 1);
    assert.equal(new Set(Object.values(s.words)).size, 2);
    for (const u of users.slice(0, count)) {
      const own = view(r, u); assert.equal(own.me.word, s.words[u.id]); assert.ok(!own.roles && !own.words && !own.me.role);
      assert.ok(own.players.every(p => !p.word && !p.role));
    }
    assert.throws(() => game.create(users[0], 'uno'), e => e.code === 'ALREADY_IN_ROOM');
    act(r, 'leave');
  }
  assert.throws(() => game.create(users[0], 'unknown'), e => e.status === 400);
});
test('卧底按顺序描述、禁止泄词和过期操作，投票不能覆盖或投自己', () => {
  const r = setup('undercover', 5), current = view(r), speaker = users.find(u => u.id === current.speakerId), other = users.find(u => u.id !== speaker.id);
  assert.throws(() => act(r, 'speak', { text: '描述' }, other), e => e.status === 403);
  assert.throws(() => act(r, 'speak', { text: `我的是${view(r, speaker).me.word}` }, speaker), e => e.status === 400);
  act(r, 'speak', { text: '一句线索' }, speaker);
  assert.throws(() => game.act(r.id, { action: 'speak', text: '重复', turn: current.turn }, speaker), e => e.code === 'GAME_CHANGED');
  describeAll(r);
  assert.throws(() => act(r, 'votePlayer', { targetId: users[0].id }), e => e.status === 400);
  act(r, 'votePlayer', { targetId: users[1].id });
  assert.equal(view(r, users[1]).history.length, 0); assert.equal(view(r, users[1]).me.vote, null);
  assert.throws(() => act(r, 'votePlayer', { targetId: users[2].id }), e => e.code === 'ALREADY_SUBMITTED');
});
test('卧底平票只对最高票成员加赛，再平票进入下一轮', () => {
  const r = setup('undercover', 4); describeAll(r);
  const cast = () => [1, 0, 0, 1].forEach((target, i) => act(r, 'votePlayer', { targetId: users[target].id }, users[i]));
  cast(); assert.equal(view(r).phase, 'voteResult'); act(r, 'advance');
  assert.equal(view(r).runoff, true); assert.deepEqual([...view(r).order].sort(), [users[0].id, users[1].id]);
  describeAll(r); assert.throws(() => act(r, 'votePlayer', { targetId: users[2].id }), e => e.status === 400);
  cast(); act(r, 'advance'); assert.equal(view(r).round, 2); assert.ok(!view(r).runoff); assert.equal(view(r).players.filter(p => p.eliminated).length, 0);
});
test('卧底出局禁止继续投票，平民与卧底两种胜负都能结算', () => {
  const r = setup('undercover', 7), s = raw(r), civilians = users.slice(0, 7).filter(u => s.roles[u.id] === 'civilian');
  assert.equal(records.list(users[0]).total, 0);
  eliminate(r, civilians[0].id); assert.equal(view(r).phase, 'voteResult'); assert.ok(!view(r).me.word || typeof view(r).me.word === 'string'); act(r, 'advance'); describeAll(r);
  assert.throws(() => act(r, 'votePlayer', { targetId: civilians[1].id }, civilians[0]), e => e.status === 403);
  eliminate(r, civilians[1].id); act(r, 'advance'); eliminate(r, civilians[2].id);
  assert.equal(view(r).winner, 'undercover'); assert.ok(view(r).players.every(p => p.word && p.role));
  const history = records.list(users[0]); assert.equal(history.total, 1);
  assert.ok(records.get(history.items[0].id, users[6]).players.every(p => p.word && p.role));
  assert.throws(() => records.get(history.items[0].id, users[9]), e => e.status === 404);
  act(r, 'restart'); users.slice(0, 7).forEach(u => act(r, 'ready', { ready: true }, u)); act(r, 'start'); users.slice(0, 7).forEach(u => act(r, 'acknowledge', {}, u));
  for (const id of Object.keys(raw(r).roles).filter(id => raw(r).roles[id] === 'undercover').map(Number)) { eliminate(r, id); if (view(r).phase !== 'finished') act(r, 'advance'); }
  assert.equal(view(r).winner, 'civilian');
  assert.equal(records.list(users[0], { game: 'undercover' }).total, 2);
  assert.equal(records.list(users[0], { game: 'uno' }).total, 0);
});
function inventory(s) { return [...Object.values(s.hands).flat(), ...s.deck, ...s.discard]; }
test('UNO 发七张、108 张牌守恒，其他玩家手牌不经接口返回', () => {
  for (const n of [2, 5, 10]) {
    const r = setup('uno', n), s = raw(r), cards = inventory(s);
    assert.equal(cards.length, 108); assert.equal(new Set(cards.map(c => c.id)).size, 108);
    for (const u of users.slice(0, n)) { const v = view(r, u); assert.equal(v.me.hand.length, 7); assert.ok(!v.deck && !v.hands); assert.ok(v.players.every(p => p.cardCount === 7 && !p.hand)); }
    assert.throws(() => act(r, 'draw', {}, users.find(u => u.id !== s.currentId)), e => e.status === 403);
    act(r, 'leave');
  }
});
function fixture(r, ownIds, { color = 'purple', top = 'purple-5-0', nextDraw } = {}) {
  const s = raw(r), pool = new Map(inventory(s).map(c => [c.id, c]));
  const get = id => { const c = pool.get(id); assert.ok(c, id); pool.delete(id); return c; };
  s.hands = { [users[0].id]: ownIds.map(get), [users[1].id]: ['green-3-0', 'gold-2-0'].map(get) };
  s.discard = [get(top)]; const draw = nextDraw ? get(nextDraw) : null; s.deck = [...pool.values(), ...(draw ? [draw] : [])];
  s.color = color; s.currentId = users[0].id; s.direction = 1; s.drawnId = null; s.turn++; put(r, s); return s;
}
test('UNO 同数字、反转、跳过、+2/+4与换色规则，由服务端执行', () => {
  const r = setup('uno', 2);
  for (const kind of ['reverse', 'skip', 'draw2']) {
    fixture(r, [`purple-${kind}-0`, 'blue-1-0', 'wild-0']);
    act(r, 'playCard', { cardId: `purple-${kind}-0` });
    assert.equal(view(r).currentId, users[0].id);
    if (kind === 'reverse') assert.equal(view(r).direction, -1);
    if (kind === 'draw2') assert.equal(view(r).players[1].cardCount, 4);
  }
  fixture(r, ['blue-5-0', 'blue-1-0', 'wild-0']); act(r, 'playCard', { cardId: 'blue-5-0' }); assert.equal(view(r).color, 'blue');
  fixture(r, ['draw4-0', 'purple-0-0', 'wild-0']); assert.throws(() => act(r, 'playCard', { cardId: 'draw4-0', color: 'green' }), e => e.status === 400);
  fixture(r, ['draw4-0', 'blue-0-0', 'wild-0']); assert.throws(() => act(r, 'playCard', { cardId: 'draw4-0', color: 'invalid' }), e => e.status === 400);
  act(r, 'playCard', { cardId: 'draw4-0', color: 'green' }); assert.equal(view(r).color, 'green'); assert.equal(view(r).players[1].cardCount, 6);
  assert.equal(inventory(raw(r)).length, 108);
});
test('UNO 抽牌后只能出新牌或跳过，忘喊 UNO 补两张，旧回合不能再操作', () => {
  const r = setup('uno', 2);
  fixture(r, ['blue-5-0', 'purple-3-0'], { nextDraw: 'green-5-0' });
  const before = view(r); act(r, 'draw'); assert.ok(view(r).drawn);
  assert.throws(() => act(r, 'draw'), e => e.status === 400);
  assert.throws(() => act(r, 'playCard', { cardId: 'blue-5-0' }), e => e.status === 400);
  act(r, 'pass'); assert.notEqual(view(r).currentId, users[0].id);
  assert.throws(() => game.act(r.id, { action: 'draw', turn: before.turn }, users[0]), e => e.code === 'GAME_CHANGED');
  fixture(r, ['purple-3-0', 'blue-2-0']); act(r, 'playCard', { cardId: 'purple-3-0' }); assert.equal(view(r).me.hand.length, 3);
  fixture(r, ['purple-3-0', 'blue-2-0']); act(r, 'playCard', { cardId: 'purple-3-0', uno: true }); assert.equal(view(r).me.hand.length, 1);
});
test('UNO 能完成整局、洗回弃牌并保持牌数，结束后支持重开', () => {
  const r = setup('uno', 2);
  let steps = 0;
  while (view(r).phase !== 'finished' && steps++ < 3000) {
    const u = users.find(u => u.id === view(r).currentId), v = view(r, u), playable = v.me.hand.find(c => c.playable);
    if (playable) act(r, 'playCard', { cardId: playable.id, color: 'purple', uno: true }, u);
    else if (v.drawn) act(r, 'pass', {}, u);
    else act(r, 'draw', {}, u);
    const cards = inventory(raw(r)); assert.equal(cards.length, 108); assert.equal(new Set(cards.map(c => c.id)).size, 108);
  }
  assert.equal(view(r).phase, 'finished'); assert.ok(view(r).winner); act(r, 'restart'); assert.equal(view(r).phase, 'waiting');
  const list = records.list(users[0]); assert.equal(list.total, 1);
  const record = records.get(list.items[0].id, users[1]);
  assert.ok(record.players.every(p => Number.isInteger(p.cardCount) && !p.hand));
  assert.ok(record.events.length > 0 && record.events.length <= 500); assert.ok(!record.hands && !record.deck && !record.me);
  assert.throws(() => records.get(record.id, users[9]), e => e.status === 404);
});
test('未开始不留记录，游戏中退出/解散归档，离开者仍可查且重复操作不重复归档', () => {
  const waiting = game.create(users[0], 'uno'); act(waiting, 'leave'); assert.equal(records.list(users[0]).total, 0);
  const r = setup('undercover', 4); act(r, 'leave', {}, users[1]);
  const history = records.list(users[1]); assert.equal(history.total, 1); assert.equal(history.items[0].status, 'abandoned');
  assert.equal(history.items[0].players.length, 4);
  act(r, 'leave'); assert.equal(records.list(users[0]).total, 1);
  const uno = setup('uno', 2); act(uno, 'leave');
  assert.equal(records.list(users[0]).total, 2); assert.equal(records.list(users[0], { game: 'uno' }).total, 1);
  setup('uno', 2); db.run('UPDATE playground_rooms SET updated_at=?', '2000-01-01T00:00:00.000Z');
  assert.equal(game.current(users[0]), null); assert.equal(records.list(users[0]).total, 3);
  assert.throws(() => records.list(users[0], { game: 'bad' }), e => e.status === 400);
});
test('仅本局房主可以删除记录，删除后所有参与者不可查且不影响其他记录', () => {
  const first = setup('uno', 2); act(first, 'leave');
  const second = setup('undercover', 4); act(second, 'leave');
  const firstRecord = records.list(users[0], { game: 'uno' }).items[0];
  assert.equal(firstRecord.canDelete, true);
  assert.equal(records.get(firstRecord.id, users[1]).canDelete, false);
  for (const role of ['employee', 'admin', 'super_admin']) assert.throws(() => records.remove(firstRecord.id, { ...users[1], role }), e => e.status === 403);
  assert.throws(() => records.remove(firstRecord.id, users[9]), e => e.status === 404);
  records.remove(firstRecord.id, users[0]);
  assert.equal(records.list(users[0], { game: 'uno' }).total, 0);
  assert.equal(records.list(users[1]).total, 1);
  assert.equal(db.pluck('SELECT COUNT(*) FROM playground_record_members WHERE record_id=?', firstRecord.id), 0);
  assert.throws(() => records.get(firstRecord.id, users[1]), e => e.status === 404);
  assert.throws(() => records.remove(firstRecord.id, users[0]), e => e.status === 404);
});
test('v37 记录安全补齐房主，迁移幂等且其他参与者没有删除权限', () => {
  const r = setup('uno', 2); act(r, 'leave');
  const record = records.list(users[0]).items[0];
  db.exec('ALTER TABLE playground_records DROP COLUMN host_id; PRAGMA user_version=37;');
  migrate(); migrate();
  assert.equal(db.pluck('SELECT host_id FROM playground_records WHERE id=?', record.id), users[0].id);
  assert.equal(records.get(record.id, users[0]).canDelete, true);
  assert.equal(records.get(record.id, users[1]).canDelete, false);
});

test('绘画猜词只给绘画者答案，画布边界、权限和猜测保密由服务端校验', () => {
  const r = setup('sketch', 3), s = raw(r), drawer = users.find(u => u.id === s.drawerId), others = users.slice(0, 3).filter(u => u.id !== s.drawerId);
  assert.equal(view(r, drawer).game, 'sketch'); assert.ok(view(r, drawer).answer);
  for (const u of others) { const v = view(r, u); assert.ok(!v.answer && !v.promptIndex && !v.prompts); assert.equal(v.rounds.length, 0); }
  const stroke = { color: '#3159aa', width: 4, points: [[0, 0], [1, 1]] };
  assert.throws(() => act(r, 'stroke', stroke, others[0]), e => e.status === 403);
  assert.throws(() => act(r, 'stroke', { ...stroke, points: [[2, 0]] }, drawer), e => e.status === 400);
  assert.throws(() => act(r, 'stroke', { ...stroke, points: [[NaN, 0]] }, drawer), e => e.status === 400);
  assert.throws(() => act(r, 'stroke', { ...stroke, points: Array(201).fill([0, 0]) }, drawer), e => e.status === 400);
  assert.throws(() => act(r, 'stroke', { ...stroke, color: 'url(https://evil.example)' }, drawer), e => e.status === 400);
  act(r, 'stroke', stroke, drawer); assert.deepEqual(view(r, others[0]).strokes, [stroke]);
  act(r, 'undoStroke', {}, drawer); assert.equal(view(r).strokes.length, 0);
  act(r, 'stroke', stroke, drawer); act(r, 'clearCanvas', {}, drawer); assert.equal(view(r).strokes.length, 0);
  assert.throws(() => act(r, 'describeDrawing', { text: view(r, drawer).answer }, drawer), e => e.status === 400);
  act(r, 'describeDrawing', { text: '这是本轮的画面线索' }, drawer); assert.equal(view(r, others[0]).description, '这是本轮的画面线索');
  assert.throws(() => act(r, 'guessDrawing', { text: view(r, drawer).answer }, drawer), e => e.status === 403);
  act(r, 'guessDrawing', { text: '不是正确答案' }, others[0]);
  act(r, 'guessDrawing', { text: view(r, drawer).answer }, others[0]);
  const other = view(r, others[1]); assert.equal(other.phase, 'drawing'); assert.equal(other.guesses.at(-1).text, '猜对了！');
  assert.ok(!JSON.stringify(other).includes(view(r, drawer).answer));
  assert.equal(other.players.find(p => p.id === others[0].id).score, 100); assert.equal(other.players.find(p => p.id === drawer.id).score, 30);
  assert.throws(() => act(r, 'guessDrawing', { text: '重复猜测' }, others[0]), e => e.code === 'ALREADY_SUBMITTED');
  act(r, 'guessDrawing', { text: view(r, drawer).answer }, others[1]);
  assert.equal(view(r).phase, 'drawingResult'); assert.ok(view(r, others[1]).answer);
  assert.equal(view(r).players.find(p => p.id === others[1].id).score, 80); assert.equal(view(r).rounds.length, 1);
});
test('绘画猜词逐人轮值，结束留存记录，支持并列与房主删除', () => {
  const r = setup('sketch', 2); const answers = [];
  for (let round = 0; round < 2; round++) {
    const v = view(r), drawer = users.find(u => u.id === v.drawerId), guesser = users.slice(0, 2).find(u => u.id !== v.drawerId), oldTurn = v.turn;
    answers.push(view(r, drawer).answer); act(r, 'guessDrawing', { text: view(r, drawer).answer }, guesser);
    assert.throws(() => game.act(r.id, { action: 'guessDrawing', turn: oldTurn, text: '旧猜测' }, guesser), e => e.code === 'GAME_CHANGED');
    act(r, 'advance');
  }
  assert.equal(new Set(answers).size, 2); assert.equal(view(r).phase, 'finished'); assert.deepEqual(view(r).winner, users.slice(0, 2).map(u => u.id));
  const result = records.list(users[0], { game: 'sketch' }); assert.equal(result.total, 1);
  const record = records.get(result.items[0].id, users[1]); assert.equal(record.rounds.length, 2); assert.equal(record.scores[users[0].id], 130);
  assert.ok(!record.strokes && !record.prompts); assert.throws(() => records.get(record.id, users[2]), e => e.status === 404);
  assert.throws(() => records.remove(record.id, users[1]), e => e.status === 403);
  act(r, 'restart'); assert.equal(view(r).phase, 'waiting'); assert.equal(view(r).rounds.length, 0);
  records.remove(record.id, users[0]); assert.equal(records.list(users[0]).total, 0);
});
test('绘画猜词限制猜测次数和笔迹数量，非房主非绘画者不得提前揭晓', () => {
  const r = setup('sketch', 3), drawer = users.find(u => u.id === view(r).drawerId), other = users[1];
  for (let i = 0; i < 10; i++) act(r, 'guessDrawing', { text: '错误答案' }, other);
  assert.throws(() => act(r, 'guessDrawing', { text: '错误答案' }, other), e => e.status === 400);
  assert.throws(() => act(r, 'advance', {}, other), e => e.status === 403);
  const s = raw(r); s.strokes = Array(200).fill({ color: '#3159aa', width: 4, points: [[0, 0]] }); put(r, s);
  assert.throws(() => act(r, 'stroke', { color: '#3159aa', width: 4, points: [[0, 0]] }, drawer), e => e.status === 400);
  act(r, 'advance'); assert.equal(view(r).phase, 'drawingResult'); act(r, 'advance');
  assert.equal(view(r).round, 2); assert.equal(view(r).strokes.length, 0); assert.equal(view(r).guesses.length, 0);
  act(r, 'leave'); const record = records.list(users[0], { game: 'sketch' }).items[0];
  assert.equal(record.status, 'abandoned'); assert.equal(records.get(record.id, users[1]).rounds.length, 1);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const db = require('../src/db/db');
const { migrate, truncateAll } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo');
const learning = require('../src/services/learningService'), harvest = require('../src/services/harvestService');
const party = require('../src/services/partyService'), records = require('../src/services/gameRecordService');
const levels = require('../src/content/bible-levels.json'), data = require('../src/content/bible-games.json');
const { createApp } = require('../src/app'), { issueSession } = require('../src/services/authService');
const { once } = require('node:events');
let users;
test.before(() => { db.open(':memory:'); migrate(); });
test.beforeEach(() => { truncateAll(); users = Array.from({ length: 3 }, (_, i) => ({ id: insertUser({ employeeNo: `HARVEST${i}`, name: `学习者${i}`, passwordHash: 'fixture', role: i === 2 ? 'super_admin' : 'employee' }), role: i === 2 ? 'super_admin' : 'employee' })); });
test.after(() => db.close());
const raw = id => JSON.parse(db.get('SELECT state_json FROM playground_lessons WHERE id=?', id).state_json);
function act(view, action, body = {}, user = users[0]) { return learning.act(view.id, user, { action, index: view.index, ...body }); }
function solve(view, wrongCount = 0, user = users[0]) {
  while (view.phase === 'active') {
    const s = raw(view.id), item = s.items[s.index];
    if (s.game === 'match') {
      const left = s.matched.length;
      view = act(view, 'pair', { leftId: s.leftIds[left], rightId: s.rightIds[left] }, user); continue;
    }
    let answer;
    if (s.game === 'quiz') answer = view.index < wrongCount ? item.options.find(v => v !== item.answer) : item.answer;
    if (s.game === 'identity') answer = item.answer;
    if (s.game === 'map') answer = item.name;
    if (s.game === 'verse' || s.game === 'timeline') {
      const remaining = [...s.choices[s.index]];
      answer = (item.events || item.parts).map(text => remaining.splice(remaining.findIndex(c => c.text === text), 1)[0].id);
    }
    view = act(view, 'answer', { answer, score: 999999, amount: 999999 }, user);
    view = act(view, 'next', {}, user);
  }
  return view;
}
test('202条题目分成42个固定关卡，配置无重复遗漏，已有题目编号稳定', () => {
  const banks = { quiz: 'quiz', identity: 'identity', timeline: 'timelines', verse: 'verses', match: 'relations', map: 'places' };
  let questions = 0, count = 0;
  for (const [game, bank] of Object.entries(banks)) {
    const ids = data[bank].map(q => q.id); assert.equal(new Set(ids).size, ids.length);
    const used = levels[game].flatMap(l => l.items); assert.equal(new Set(used).size, used.length);
    assert.deepEqual([...used].sort(), [...ids].sort()); assert.equal(new Set(levels[game].map(l => l.id)).size, levels[game].length);
    for (const level of levels[game]) {
      assert.ok(level.items.length >= 2);
      if (game === 'map') assert.equal(new Set(level.items.map(id => data.places.find(p => p.id === id).region)).size, 1);
    }
    questions += ids.length; count += levels[game].length;
  }
  assert.equal(questions, 202); assert.equal(count, 42); assert.equal(data.quiz[0].id, 'q-001');
});
test('关卡锁定由服务器检查，80%以下不能跳关，重复请求不能重复获得禾穗', () => {
  assert.equal(harvest.list(users[0]).balance, 0);
  assert.throws(() => learning.start(users[0], { game: 'quiz', levelId: 'quiz-02' }), e => e.status === 403);
  let view = learning.start(users[0], { game: 'quiz', levelId: 'quiz-01' });
  assert.equal(learning.start(users[0], { game: 'quiz', levelId: 'quiz-01' }).id, view.id);
  assert.throws(() => learning.get(view.id, users[1]), e => e.status === 404);
  assert.throws(() => act(view, 'next'), e => e.status === 400);
  assert.throws(() => act(view, 'answer', { answer: '伪造答案', score: 100000 }), e => e.status === 400);
  assert.ok(!view.question.answer && !view.items && !view.question.explain);
  view = solve(view, 2); assert.equal(view.score, 60); assert.equal(view.passed, false); assert.equal(view.nextLevelId, null); assert.equal(view.reward.amount, 8);
  const total = harvest.balance(users[0].id), retry = act(view, 'next'); assert.equal(retry.reward.balance, total);
  assert.equal(harvest.list(users[0]).total, 1); assert.equal(harvest.list(users[1]).balance, 0);
  assert.throws(() => learning.start(users[0], { game: 'quiz', levelId: 'quiz-02' }), e => e.status === 403);
});
test('重闯刷新最近和最佳成绩，通关永久保留；新增关卡不会重置旧进度', () => {
  let first = solve(learning.start(users[0], { game: 'quiz', levelId: 'quiz-01' }), 1);
  assert.equal(first.score, 70); assert.ok(first.passed && first.newBest); assert.equal(first.nextLevelId, 'quiz-02');
  const replay = solve(learning.start(users[0], { game: 'quiz', levelId: 'quiz-01' }));
  assert.equal(replay.score, 80); assert.equal(replay.reward.amount, 0); assert.match(replay.reward.reason, /今日首次完成/);
  const lower = solve(learning.start(users[0], { game: 'quiz', levelId: 'quiz-01' }), 4); assert.equal(lower.score, 40); assert.equal(lower.newBest, false); assert.ok(lower.nextLevelId);
  const progress = learning.metadata(users[0]).levels.quiz[0]; assert.deepEqual([progress.bestScore, progress.lastScore, progress.attempts, progress.cleared], [80, 40, 3, true]);
  assert.equal(learning.start(users[0], { game: 'quiz', levelId: 'quiz-02' }).level.number, 2);
  levels.quiz.push({ id: 'quiz-test-new', title: '后续新增', items: ['q-001', 'q-002'] });
  try { const meta = learning.metadata(users[0]); assert.ok(meta.levels.quiz[0].cleared); assert.equal(meta.levels.quiz.at(-1).unlocked, false); } finally { levels.quiz.pop(); }
  assert.equal(harvest.list(users[0]).total, 1); assert.equal(harvest.list(users[0], { page: 2 }).items.length, 0);
});
test('每日奖励按北京时间零点重置，以完成日计入；刷新旧结果不能补领', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-26T15:59:59.000Z') });
  try {
    const first = solve(learning.start(users[0], { game: 'quiz' }));
    assert.equal(first.reward.amount, 13);
    const replay = solve(learning.start(users[0], { game: 'quiz' }));
    assert.equal(replay.reward.amount, 0);
    const overnight = learning.start(users[0], { game: 'quiz' });
    t.mock.timers.setTime(Date.parse('2026-11-26T16:00:00.000Z'));
    assert.equal(learning.get(replay.id, users[0]).reward.amount, 0);
    assert.match(learning.get(replay.id, users[0]).reward.reason, /今日首次完成/);
    assert.equal(act(first, 'next').reward.amount, 13);
    assert.equal(harvest.balance(users[0].id), 13);
    const nextDay = solve(overnight);
    assert.equal(nextDay.reward.amount, 13); assert.equal(harvest.balance(users[0].id), 26);
    assert.equal(solve(learning.start(users[0], { game: 'quiz' })).reward.amount, 0);
    assert.equal(harvest.list(users[0]).total, 2);
  } finally { t.mock.timers.reset(); }
});
test('奖励按账号、游戏、关卡独立；当天第一次未通关也占用奖励，重玩仍解锁并刷新成绩', () => {
  const failed = solve(learning.start(users[0], { game: 'quiz' }), 8);
  assert.equal(failed.passed, false); assert.equal(failed.reward.amount, 2);
  const passed = solve(learning.start(users[0], { game: 'quiz' }));
  assert.ok(passed.passed && passed.newBest); assert.equal(passed.reward.amount, 0);
  assert.equal(passed.nextLevelId, 'quiz-02');
  assert.equal(solve(learning.start(users[0], { game: 'quiz', levelId: 'quiz-02' })).reward.amount, 13);
  assert.equal(solve(learning.start(users[0], { game: 'match' })).reward.amount, 9);
  assert.equal(solve(learning.start(users[1], { game: 'quiz' }), 0, users[1]).reward.amount, 13);
  assert.equal(harvest.balance(users[0].id), 24); assert.equal(harvest.balance(users[1].id), 13);
  const progress = learning.metadata(users[0]).levels.quiz[0];
  assert.deepEqual([progress.bestScore,progress.lastScore,progress.attempts,progress.cleared], [80,80,2,true]);
});
test('奖励写入失败时成绩与每日资格一并回滚，重试仍可领取首次奖励', () => {
  let view = learning.start(users[0], { game: 'quiz' });
  while (view.index < view.count - 1) {
    view = act(view, 'answer', { answer: raw(view.id).items[view.index].answer }); view = act(view, 'next');
  }
  view = act(view, 'answer', { answer: raw(view.id).items[view.index].answer });
  db.exec("CREATE TRIGGER fail_harvest BEFORE INSERT ON playground_harvest BEGIN SELECT RAISE(ABORT,'harvest failure'); END;");
  try { assert.throws(() => act(view, 'next'), /harvest failure/); } finally { db.exec('DROP TRIGGER fail_harvest'); }
  assert.equal(learning.get(view.id,users[0]).phase, 'active');
  assert.equal(learning.metadata(users[0]).levels.quiz[0].attempts, 0); assert.equal(harvest.balance(users[0].id), 0);
  const done = act(view, 'next'); assert.equal(done.reward.amount, 13);
  assert.equal(act(done,'next').reward.amount, 13); assert.equal(harvest.balance(users[0].id), 13);
});
test('全部六种学习游戏由服务器判分，词块顺序不泄露、重复词块可互换，刷新可继续', () => {
  for (const game of ['quiz','identity','timeline','verse','match','map']) {
    let view = learning.start(users[0], { game });
    assert.equal(learning.get(view.id, users[0]).id, view.id);
    if (game === 'verse' || game === 'timeline') assert.ok(view.question.choices.every(c => !Object.hasOwn(c,'index')));
    if (game === 'identity') {
      assert.equal(view.question.clues.length, 1); view = act(view, 'hint'); assert.equal(view.question.clues.length, 2);
    }
    view = solve(view); assert.equal(view.phase, 'completed'); assert.ok(view.reward.amount > 0 && view.reward.amount < 100);
    assert.equal(view.level.maximum, view.count * 10);
    assert.ok(view.results.every(result => Number.isInteger(result.score) && result.score >= 0 && result.score <= 10));
    assert.equal(view.score, game === 'identity' ? 37 : view.count * 10);
  }
  assert.equal(harvest.list(users[0]).total, 6);
  assert.throws(() => learning.metadata(users[2]), e => e.status === 403);
  assert.throws(() => learning.start(users[0], { game: 'quiz', levelId: 'verse-01' }), e => e.status === 404);
});
test('80%边界按原始成绩判断，匹配扣分不能伪造或重复匹配，多次揭晓只得零分', () => {
  let view = learning.start(users[0], { game: 'match' }), s = raw(view.id);
  for (let i = 0; i < 4; i++) view = act(view, 'pair', { leftId: s.leftIds[0], rightId: s.rightIds[1] });
  view = solve(view); assert.equal(view.score, 32); assert.equal(view.passed, true); assert.equal(view.reward.amount, 5);
  view = learning.start(users[0], { game: 'identity' }); const firstIndex = view.index;
  view = act(view, 'reveal'); assert.equal(view.feedback.score, 0);
  view = act(view, 'answer', { answer: raw(view.id).items[0].answer, score: 100 }); assert.equal(view.feedback.score, 0);
  view = act(view, 'next'); assert.throws(() => learning.act(view.id, users[0], { action: 'answer', index: firstIndex, answer: '旧答案' }), e => e.code === 'LESSON_CHANGED');
  view = solve(view); assert.equal(view.score, 30); assert.equal(view.passed, false);
  assert.throws(() => learning.start(users[0], { game: 'identity', levelId: 'identity-02' }), e => e.status === 403);
});
test('未完成、切换关卡和旧记录不奖励，联机胜负分别奖励，删除记录不影响禾穗', () => {
  let view = learning.start(users[0], { game: 'quiz' }); assert.equal(harvest.list(users[0]).balance, 0);
  const r = party.create(users[0], 'uno'); party.join(r.code, users[1]);
  for (const u of users.slice(0, 2)) party.act(r.id, { action:'ready',turn:party.get(r.id,u).turn,ready:true }, u);
  party.act(r.id,{action:'start',turn:party.get(r.id,users[0]).turn},users[0]);
  const room = db.get('SELECT * FROM playground_rooms WHERE id=?',r.id), state = JSON.parse(room.state_json);
  state.phase = 'finished'; state.winner = users[0].id;
  db.tx(() => records.archive(room,state,users.slice(0,2).map((u,i)=>({id:u.id,name:`学习者${i}`}))));
  assert.equal(harvest.balance(users[0].id),15); assert.equal(harvest.balance(users[1].id),5);
  db.tx(() => records.archive(room,state,users.slice(0,2))); assert.equal(harvest.balance(users[0].id),15);
  records.remove(state.recordId,users[0]); assert.equal(harvest.balance(users[0].id),15);
  const before = harvest.list(users[0]).total;
  harvest.party(999,{ game:'uno',winner:null },users.slice(0,2)); assert.equal(harvest.list(users[0]).total,before);
  assert.equal(learning.get(view.id,users[0]).phase,'active');
});
test('HTTP接口必须登录，不能读取或提交他人挑战，不能指定他人领取禾穗', async () => {
  const server = createApp().listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/playground`;
  try {
    for (const path of ['/harvest','/learning/meta']) assert.equal((await fetch(base+path)).status,401);
    const headers = { Authorization: `Bearer ${issueSession(users[0].id).token}`, 'Content-Type':'application/json' };
    let response = await fetch(base+'/learning',{method:'POST',headers,body:JSON.stringify({game:'quiz',levelId:'quiz-02'})}); assert.equal(response.status,403);
    response = await fetch(base+'/learning',{method:'POST',headers,body:JSON.stringify({game:'quiz',userId:users[1].id})}); const {data:lesson}=await response.json(); assert.equal(response.status,201);
    const other = { Authorization: `Bearer ${issueSession(users[1].id).token}`, 'Content-Type':'application/json' };
    assert.equal((await fetch(base+`/learning/${lesson.id}`,{headers:other})).status,404);
    assert.equal((await fetch(base+`/learning/${lesson.id}/actions`,{method:'POST',headers:other,body:JSON.stringify({action:'next',index:0})})).status,404);
    assert.equal((await fetch(base+'/harvest?page=0',{headers})).status,400);
    assert.equal((await fetch(base+'/harvest',{method:'POST',headers,body:JSON.stringify({amount:10000,userId:users[1].id})})).status,404);
  } finally { server.close(); }
});

test('各联机游戏按阵营或个人胜负奖励，你画我猜的成绩奖励独立累计', () => {
  const players = users.slice(0,2), [a,b] = players.map(p=>p.id);
  db.tx(()=>{
    harvest.party(101,{game:'avalon',roles:{[a]:'prophet',[b]:'deceiver'},winner:'light'},players);
    harvest.party(102,{game:'undercover',roles:{[a]:'civilian',[b]:'undercover'},winner:'undercover'},players);
    harvest.party(103,{game:'sketch',scores:{[a]:230,[b]:130},winner:[a]},players);
  });
  assert.equal(harvest.balance(a),37); assert.equal(harvest.balance(b),26);
  db.tx(()=>harvest.party(103,{game:'sketch',scores:{[a]:999,[b]:999},winner:[a,b]},players));
  assert.equal(harvest.balance(a),37); assert.equal(harvest.balance(b),26);
});
test('v38升级创建学习与收获表，不改用户和历史游戏，不给历史记录补发', () => {
  const before = db.pluck('SELECT COUNT(*) FROM users');
  db.exec('DROP TABLE playground_progress; DROP TABLE playground_lessons; DROP TABLE playground_harvest; PRAGMA user_version=38;');
  assert.deepEqual(migrate(),{fromVersion:38,toVersion:43});
  assert.equal(db.pluck('SELECT COUNT(*) FROM users'),before);
  assert.equal(db.get('PRAGMA quick_check').quick_check,'ok'); assert.equal(db.all('PRAGMA foreign_key_check').length,0);
  assert.equal(harvest.list(users[0]).balance,0);
  assert.equal(learning.metadata(users[0]).levels.quiz[0].unlocked,true);
});
test('v41成绩按十分之一迁移一次，保留进行中进度、通关和禾穗；继续答题使用10分制', () => {
  const completed = solve(learning.start(users[0], { game: 'quiz' }), 1);
  solve(learning.start(users[0], { game: 'quiz' }), 2);
  let abandoned = learning.start(users[0], { game: 'quiz' });
  abandoned = act(abandoned,'answer',{answer:raw(abandoned.id).items[0].answer});
  let active = learning.start(users[0], { game: 'quiz', levelId:'quiz-02' });
  active = act(active,'answer',{answer:raw(active.id).items[0].answer}); active = act(active,'next');
  let match = learning.start(users[0], { game:'match' }), s = raw(match.id);
  match = act(match,'pair',{leftId:s.leftIds[0],rightId:s.rightIds[1]});
  match = act(match,'pair',{leftId:s.leftIds[0],rightId:s.rightIds[0]});
  match = act(match,'pair',{leftId:s.leftIds[1],rightId:s.rightIds[2]});
  let identity = learning.start(users[0], { game:'identity' });
  identity = act(identity,'hint'); identity = act(identity,'answer',{answer:raw(identity.id).items[0].answer}); identity = act(identity,'next');
  const balance = harvest.balance(users[0].id), saved = db.all('SELECT * FROM playground_lessons');
  const room = party.create(users[0], 'sketch'), roomState = db.pluck('SELECT state_json FROM playground_rooms WHERE id=?',room.id);
  for (const lesson of saved) {
    const state=JSON.parse(lesson.state_json);
    state.results=state.results.map(result=>result ? {...result,score:result.score*10} : result);
    if (state.score!=null) state.score*=10;
    if (state.maximum!=null) state.maximum*=10;
    db.run('UPDATE playground_lessons SET state_json=? WHERE id=?',JSON.stringify(state),lesson.id);
  }
  db.exec('UPDATE playground_progress SET best_score=best_score*10,last_score=last_score*10,max_score=max_score*10; PRAGMA user_version=41;');
  assert.deepEqual(migrate(),{fromVersion:41,toVersion:43});
  for (const lesson of saved) assert.deepEqual(db.get('SELECT * FROM playground_lessons WHERE id=?',lesson.id),lesson);
  const progress=learning.metadata(users[0]).levels.quiz[0];
  assert.deepEqual([progress.bestScore,progress.lastScore,progress.maximum,progress.attempts,progress.cleared],[70,60,80,2,true]);
  assert.equal(learning.get(completed.id,users[0]).score,70);
  assert.equal(learning.get(completed.id,users[0]).reward.amount,9);
  assert.equal(harvest.balance(users[0].id),balance);
  assert.equal(db.pluck('SELECT state_json FROM playground_rooms WHERE id=?',room.id),roomState);
  assert.deepEqual(migrate(),{fromVersion:43,toVersion:43});
  assert.equal(learning.get(active.id,users[0]).score,10); assert.equal(learning.get(active.id,users[0]).index,1);
  const continued = solve(learning.get(active.id,users[0]));
  assert.equal(continued.score,80); assert.equal(continued.reward.amount,13);
  assert.equal(solve(learning.get(match.id,users[0])).score,36);
  assert.equal(solve(learning.get(identity.id,users[0])).score,37);
  assert.equal(solve(learning.start(users[0],{game:'quiz'})).reward.amount,0);
  assert.equal(db.all('PRAGMA foreign_key_check').length,0); assert.equal(db.get('PRAGMA quick_check').quick_check,'ok');
});

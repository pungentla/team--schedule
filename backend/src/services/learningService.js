'use strict';
const { randomInt, randomUUID } = require('node:crypto');
const db = require('../db/db');
const data = require('../content/bible-games.json');
const levels = require('../content/bible-levels.json');
const PASS_PERCENT = 80;
const harvest = require('./harvestService');
const { badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { requireEnum, requireInt, requireString, requireArray } = require('../utils/validate');
const banks = { quiz: 'quiz', identity: 'identity', timeline: 'timelines', verse: 'verses', match: 'relations', map: 'places' };
function shuffle(values) { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; } return result; }
const normalize = value => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
function row(id, user) {
  harvest.participant(user);
  const lesson = db.get('SELECT * FROM playground_lessons WHERE id=? AND user_id=?', requireString(id, '挑战编号', { max: 40 }), user.id);
  if (!lesson) throw notFound('挑战不存在或不属于你');
  return lesson;
}
function levelList(userId, game) {
  const progress = db.all('SELECT * FROM playground_progress WHERE user_id=? AND game=?', userId, game);
  return levels[game].map((level, i) => {
    const own = progress.find(p => p.level_id === level.id), previous = i > 0 && progress.find(p => p.level_id === levels[game][i - 1].id);
    return { id: level.id, title: level.title, number: i + 1, count: level.items.length, maximum: level.items.length * 10,
      passPercent: PASS_PERCENT, unlocked: i === 0 || !!previous?.cleared, cleared: !!own?.cleared,
      bestScore: own?.best_score ?? null, lastScore: own?.last_score ?? null, attempts: own?.attempts || 0 };
  });
}
function metadata(user) {
  harvest.participant(user);
  const all = Object.fromEntries(Object.keys(banks).map(game => [game, levelList(user.id, game)]));
  return { source: data.source, levels: all, best: Object.fromEntries(Object.entries(all).map(([game, list]) => [game, Math.max(0, ...list.map(l => Math.round(100 * (l.bestScore || 0) / l.maximum)))])) };
}
function present(lesson) {
  const s = JSON.parse(lesson.state_json), item = s.items[s.index], feedback = s.results[s.index] || null;
  let question = null;
  if (lesson.status === 'active') {
    if (s.game === 'quiz') question = { question: item.question, options: s.choices[s.index] };
    if (s.game === 'identity') question = { clues: item.clues.slice(0, s.hints), hints: s.hints, maxHints: item.clues.length };
    if (s.game === 'timeline' || s.game === 'verse') question = { title: item.title, ref: s.game === 'verse' ? item.ref : undefined, choices: s.choices[s.index] };
    if (s.game === 'map') question = { question: item.question, region: data.regions.find(r => r.id === s.filter), places: [...new Map(data.places.filter(p => p.region === s.filter).map(p => [p.name, { name: p.name, lon: p.lon, lat: p.lat }])).values()] };
    if (s.game === 'match') question = { left: s.items.map((p, i) => ({ id: s.leftIds[i], text: p.left })), right: s.right,
      matched: s.matched.map(i => ({ leftId: s.leftIds[i], rightId: s.rightIds[i], ...s.results[i] })), lastPair: s.lastPair || null };
  }
  const list = levelList(lesson.user_id, s.game), levelIndex = list.findIndex(l => l.id === s.levelId), level = list[levelIndex];
  return { id: lesson.id, game: s.game, level, passed: !!s.passed, newBest: !!s.newBest, nextLevelId: level?.cleared ? list[levelIndex + 1]?.id || null : null, filter: s.filter, phase: lesson.status, index: s.index, count: s.items.length,
    score: s.results.reduce((sum, result) => sum + (result?.score || 0), 0), question, feedback,
    results: s.results.filter(Boolean), ...(lesson.status === 'completed' ? { reward: harvest.receipt(lesson.user_id, `lesson:${lesson.id}`, s.noRewardReason) } : {}) };
}
function save(lesson, s, completed = false) {
  const updatedAt = new Date().toISOString();
  if (completed) {
    s.score = s.results.reduce((sum, result) => sum + result.score, 0); s.maximum = s.items.length * 10;
    s.passed = s.score * 100 >= s.maximum * PASS_PERCENT;
    const previous = db.get('SELECT best_score FROM playground_progress WHERE user_id=? AND game=? AND level_id=?', lesson.user_id, s.game, s.levelId);
    s.newBest = !previous || s.score > previous.best_score;
    db.run(`INSERT INTO playground_progress(user_id,game,level_id,best_score,last_score,max_score,cleared,attempts,updated_at) VALUES(?,?,?,?,?,?,?,1,?)
      ON CONFLICT(user_id,game,level_id) DO UPDATE SET best_score=MAX(best_score,excluded.best_score),last_score=excluded.last_score,max_score=excluded.max_score,
      cleared=MAX(cleared,excluded.cleared),attempts=attempts+1,updated_at=excluded.updated_at`,
      lesson.user_id,s.game,s.levelId,s.score,s.score,s.maximum,s.passed ? 1 : 0,updatedAt);
    const reward = harvest.lesson(lesson.id, lesson.user_id, s.game, s.results, s.levelId, levels[s.game].findIndex(l => l.id === s.levelId) + 1, updatedAt);
    if (!reward.amount) s.noRewardReason = reward.reason;
  }
  db.run('UPDATE playground_lessons SET status=?,state_json=?,updated_at=? WHERE id=?', completed ? 'completed' : 'active', JSON.stringify(s), updatedAt, lesson.id);
}
function start(user, body = {}) {
  harvest.participant(user);
  const game = requireEnum(body.game, '学习游戏', Object.keys(banks));
  const levelId = requireString(body.levelId || levels[game][0].id, '关卡编号', { max: 40 });
  const level = levels[game].find(l => l.id === levelId);
  if (!level) throw notFound('关卡不存在');
  return db.tx(() => {
    if (!levelList(user.id, game).find(l => l.id === levelId).unlocked) throw forbidden('请先以至少 80% 的成绩通过上一关');
    const previous = db.get("SELECT * FROM playground_lessons WHERE user_id=? AND game=? AND status='active'", user.id, game);
    if (previous && JSON.parse(previous.state_json).levelId === levelId) return present(previous);
    if (previous) db.run("UPDATE playground_lessons SET status='abandoned' WHERE id=?", previous.id);
    const items = level.items.map(id => data[banks[game]].find(item => item.id === id));
    const filter = game === 'map' ? items[0].region : 'all';
    const s = { game, filter, levelId, index: 0, items, results: [], hints: 1, matched: [], errors: {}, choices: items.map(item => {
      if (game === 'quiz') return shuffle(item.options);
      if (game !== 'timeline' && game !== 'verse') return null;
      const values = item.events || item.parts;
      const choices = shuffle(values.map(text => ({ id: randomUUID(), text })));
      if (choices.every((c, i) => c.text === values[i])) choices.push(choices.shift());
      return choices;
    }) };
    if (game === 'match') { s.leftIds = items.map(() => randomUUID()); s.rightIds = items.map(() => randomUUID()); s.right = shuffle(items.map((p, i) => ({ id: s.rightIds[i], text: p.right }))); }
    const id = randomUUID(); db.run("INSERT INTO playground_lessons(id,user_id,game,status,state_json,updated_at) VALUES(?,?,?,'active',?,?)", id, user.id, game, JSON.stringify(s), new Date().toISOString());
    return present(row(id, user));
  });
}
function get(id, user) { return present(row(id, user)); }
function grade(item, answer, correct, score, title) { return { title, answer, correct, score, explain: item.explain, ref: item.ref, url: item.url }; }
function act(id, user, body = {}) {
  return db.tx(() => {
    const lesson = row(id, user), s = JSON.parse(lesson.state_json);
    const action = requireEnum(body.action, '操作', ['answer', 'hint', 'reveal', 'next', 'pair']);
    // Completion retries are reads: they never run grading or award again.
    if (lesson.status === 'completed') return present(lesson);
    if (lesson.status !== 'active') throw conflict('LESSON_CHANGED', '挑战已切换，请重新开始');
    if (requireInt(body.index, '题目编号', { min: 0 }) !== s.index) throw conflict('LESSON_CHANGED', '题目已变化，请同步后重试');
    const item = s.items[s.index]; let completed = false;
    if (s.game === 'match') {
      if (action !== 'pair') throw badRequest('请完成左右配对');
      const left = s.leftIds.indexOf(body.leftId), right = s.rightIds.indexOf(body.rightId);
      if (left < 0 || right < 0 || s.matched.includes(right)) throw badRequest('请选择尚未配对的人物和经历');
      if (s.matched.includes(left)) return present(lesson);
      s.lastPair = { leftId: body.leftId, rightId: body.rightId, correct: left === right };
      if (left !== right) s.errors[left] = (s.errors[left] || 0) + 1;
      else { s.matched.push(left); s.results[left] = grade(s.items[left], s.items[left].right, true, Math.max(0, 10 - (s.errors[left] || 0) * 2), `${s.items[left].left} → ${s.items[left].right}`); }
      completed = s.matched.length === s.items.length;
    } else if (action === 'next') {
      if (!s.results[s.index]) throw badRequest('请先完成当前题目');
      if (s.index + 1 === s.items.length) completed = true;
      else { s.index++; s.hints = 1; }
    } else {
      if (s.results[s.index]) return present(lesson);
      if (s.game === 'identity' && action === 'hint') s.hints = Math.min(item.clues.length, s.hints + 1);
      else if (s.game === 'identity' && action === 'reveal') s.results[s.index] = grade(item, item.answer, false, 0, item.answer);
      else if (action !== 'answer') throw badRequest('当前题目不支持此操作');
      else {
        let correct, answer, title = item.question || item.title || item.ref;
        if (s.game === 'quiz') { const value = requireEnum(body.answer, '答案', s.choices[s.index]); correct = value === item.answer; answer = item.answer; }
        if (s.game === 'identity') { const value = normalize(requireString(body.answer, '人物名字', { max: 20 })); correct = !!value && [item.answer, ...(item.aliases || [])].some(a => normalize(a) === value); answer = item.answer; title = item.answer; }
        if (s.game === 'map') { const value = requireEnum(body.answer, '地点', [...new Set(data.places.filter(p => p.region === s.filter).map(p => p.name))]); correct = value === item.name; answer = item.name; }
        if (s.game === 'timeline' || s.game === 'verse') {
          const ids = requireArray(body.answer, '顺序', { min: s.choices[s.index].length, max: s.choices[s.index].length });
          const choices = s.choices[s.index];
          if (new Set(ids).size !== ids.length || !ids.every(id => choices.some(c => c.id === id))) throw badRequest('请使用全部词块或事件，不能重复');
          const values = item.events || item.parts;
          correct = ids.map(id => choices.find(c => c.id === id).text).join('\u0000') === values.join('\u0000'); answer = values.join(s.game === 'verse' ? '' : ' → ');
        }
        s.results[s.index] = grade(item, answer, correct, correct ? s.game === 'identity' ? [10, 7, 4][s.hints - 1] : 10 : 0, title);
      }
    }
    save(lesson, s, completed); return present(row(id, user));
  });
}
module.exports = { start, get, act, metadata };

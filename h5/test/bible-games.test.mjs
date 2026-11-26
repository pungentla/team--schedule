import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectPoint, moveItem, levelProgress } from '../src/playground/learning.mjs';
const data = JSON.parse(fs.readFileSync(new URL('../../backend/src/content/bible-games.json', import.meta.url)));
test('外层卡片按通关状态统计进度，未通过仍停留本关，重玩不降低进度，新增关卡可继续', () => {
  assert.equal(levelProgress(undefined), null); assert.equal(levelProgress([]), null);
  const levels = [{ number: 1, unlocked: true, cleared: false }, { number: 2, unlocked: false, cleared: false }];
  assert.deepEqual(levelProgress(levels), { cleared: 0, total: 2, percent: 0, next: 1 });
  levels[0].cleared = true; levels[0].lastScore = 0; levels[1].unlocked = true;
  assert.deepEqual(levelProgress(levels), { cleared: 1, total: 2, percent: 50, next: 2 });
  levels[1].cleared = true;
  assert.deepEqual(levelProgress(levels), { cleared: 2, total: 2, percent: 100, next: null });
  levels.push({ number: 3, unlocked: true, cleared: false });
  assert.deepEqual(levelProgress(levels), { cleared: 2, total: 3, percent: 67, next: 3 });
});
test('学习题库有出处、选项唯一、所有地区有足够题目且坐标可投影', () => {
  for (const bank of ['quiz', 'identity', 'timelines', 'verses', 'relations', 'places']) {
    assert.ok(data[bank].length >= 6, bank);
    for (const item of data[bank]) {
      assert.ok(item.ref && item.explain);
      assert.match(item.url, /^https:\/\/ebible.org\/cmn-cu89s\/[A-Z0-9]+\.htm$/);
      if (bank === 'quiz') { assert.equal(new Set(item.options).size, 4); assert.equal(item.options.filter(v => v === item.answer).length, 1); }
      if (bank === 'identity') assert.equal(item.clues.length, 3);
      if (bank === 'timelines') assert.equal(new Set(item.events).size, item.events.length);
    }
  }
  for (const region of data.regions) {
    const places = [...new Map(data.places.filter(p => p.region === region.id).map(p => [p.name, p])).values()]; assert.ok(places.length >= 3);
    assert.equal(new Set(places.map(p => p.name)).size, places.length);
    for (const p of places) { const [x, y] = projectPoint([p.lon, p.lat], region.bounds); assert.ok(x >= 40 && x <= 660 && y >= 40 && y <= 340); }
  }
});
test('排序移动不会丢失或重复事件，也不会修改原数组', () => {
  const values = [0, 1, 2, 3], moved = moveItem(values, 1, 3);
  assert.deepEqual(moved, [0, 2, 3, 1]); assert.deepEqual(values, [0, 1, 2, 3]);
  assert.deepEqual(moveItem(values, 0, -1), values);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { draw, makeGroups, parseNames, randomInt, shuffle } from '../src/playground/random.mjs';
test('名单去空白并拒绝重复、超长和超限输入', () => {
  assert.deepEqual(parseNames(' 小麦 \r\n\n葡萄'), ['小麦', '葡萄']);
  for (const text of ['', '小麦\n小麦', 'a'.repeat(81) + '\nb']) assert.throws(() => parseNames(text));
  assert.throws(() => parseNames('一\n二\n三', { max: 2 }));
});
test('抽签不重复且不修改输入，分组人数最多相差一人', () => {
  const names = Array.from({ length: 19 }, (_, i) => String(i)), original = [...names];
  for (let round = 0; round < 20; round++) {
    const picked = draw(names, 8); assert.equal(new Set(picked).size, 8); assert.ok(picked.every(n => names.includes(n)));
    for (let n = 2; n <= names.length; n++) {
      const groups = makeGroups(names, n), counts = groups.map(g => g.length);
      assert.deepEqual(groups.flat().sort(), [...names].sort()); assert.equal(groups.length, n);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
    }
  }
  assert.deepEqual(names, original); assert.notEqual(shuffle(names), names);
  for (const count of [0, null, 1.5, 20]) assert.throws(() => draw(names, count));
  for (const count of [0, 1, 1.5, 20]) assert.throws(() => makeGroups(names, count));
});
test('随机数始终落在范围内，拒绝无效范围', () => {
  for (const n of [1, 2, 6, 50]) for (let i = 0; i < 100; i++) assert.ok(randomInt(n) >= 0 && randomInt(n) < n);
  for (const n of [0, -1, NaN, 1.1, 0x100000001]) assert.throws(() => randomInt(n));
});

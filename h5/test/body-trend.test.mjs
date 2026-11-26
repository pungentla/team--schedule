import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyTrend } from '../src/playground/bodyTrend.mjs';
test('图表忽略空指标，不补零；两种指标分别计算，变化保留一位小数', () => {
  const records = [{ date: '2026-11-01', weight: 65.5, bodyFat: null }, { date: '2026-11-03', weight: null, bodyFat: 23.4 }, { date: '2026-11-10', weight: 65.2, bodyFat: 23.1 }];
  const weight = bodyTrend(records, 'weight'), fat = bodyTrend(records, 'bodyFat');
  assert.equal(weight.points.length, 2); assert.equal(fat.points.length, 2); assert.equal(weight.change, -0.3); assert.equal(fat.change, -0.3);
  assert.equal(weight.first.value, 65.5); assert.equal(fat.first.date, '2026-11-03');
});
test('横轴按真实日期间隔排列，而非等间距，也不改变原始列表顺序', () => {
  const records = [{ date: '2026-11-11', weight: 64 }, { date: '2026-11-01', weight: 65 }, { date: '2026-11-02', weight: 65.1 }], copy = structuredClone(records);
  const series = bodyTrend(records, 'weight');
  assert.deepEqual(records, copy); assert.equal(series.points[0].x, 50); assert.equal(series.points[2].x, 580); assert.equal(series.points[1].x, 103);
});
test('无数据返回空；单点与相同数值均可展示，不产生无限坐标', () => {
  assert.equal(bodyTrend([], 'weight'), null); assert.equal(bodyTrend([{ date: '2026-11-01', weight: null }], 'weight'), null);
  const one = bodyTrend([{ date: '2026-11-01', weight: 65 }], 'weight'); assert.equal(one.points[0].x, 315); assert.equal(one.change, 0);
  const flat = bodyTrend([{ date: '2026-11-01', weight: 65 }, { date: '2026-11-02', weight: 65 }], 'weight');
  assert.ok(flat.high > flat.low); assert.ok(flat.points.every(p => Number.isFinite(p.y))); assert.equal(flat.points[0].y, flat.points[1].y);
});
test('纵轴包含所有记录并保留上下空白，极小值不产生负下界', () => {
  for (const values of [[0.1], [65, 80, 55], [99.9, 100]]) {
    const series = bodyTrend(values.map((weight, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, weight })), 'weight');
    assert.ok(series.low >= 0); assert.ok(series.low <= Math.min(...values)); assert.ok(series.high >= Math.max(...values)); assert.ok(series.points.every(p => p.y >= 20 && p.y <= 150));
  }
});

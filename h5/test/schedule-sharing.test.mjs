import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleLink, readScheduleLink, scheduleLines } from '../src/scheduleSharing.mjs';
test('分享链接只保留日期和可选周期，移除旧话题、账号参数和片段',()=>{
  const link=scheduleLink('https://shift.test/?topic=3&token=private#old','2026-11-08',7);
  assert.equal(link,'https://shift.test/?scheduleDate=2026-11-08&schedulePeriod=7');
  assert.deepEqual(readScheduleLink(new URL(link).search),{date:'2026-11-08',periodId:7});
  assert.deepEqual(readScheduleLink(new URL(scheduleLink(link,'2026-12-01')).search),{date:'2026-12-01',periodId:null});
  for (const search of ['?scheduleDate=2026-02-30','?scheduleDate=bad','?scheduleDate=2026-01-01&schedulePeriod=-1','?scheduleDate=2026-01-01&schedulePeriod=NaN']) assert.equal(readScheduleLink(search),null);
});
test('图文分享保留各班次、工作、名字、主副及缺口，不带工号',()=>{
  const day={shifts:[{shiftName:'早班',workTypes:[{workTypeName:'接待',filled:1,needCount:2,gap:1,roleGaps:['deputy'],assigned:[{name:'青禾',employeeNo:'private',dutyRole:'primary'}]}]}]};
  const text=scheduleLines('2026-11-08',day,'秋季轮值').map(l=>l.text).join('\n');
  for(const value of ['秋季轮值','早班','接待','青禾（主负责人）','缺 1','缺副负责人']) assert.ok(text.includes(value));
  assert.ok(!text.includes('private'));
  assert.ok(scheduleLines('2026-11-08',null).some(l=>l.text==='当天暂无安排'));
});

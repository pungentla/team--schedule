const roles = { primary: '主负责人', deputy: '副负责人' };
export function validScheduleDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0,4))>=1900 && Number(value.slice(0,4))<=2100
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}
export function scheduleLink(base, date, periodId) {
  if (!validScheduleDate(date)) throw new Error('安排日期无效');
  const url=new URL(base);url.search='';url.hash='';url.searchParams.set('scheduleDate',date);
  if (periodId!=null) {
    if (!Number.isSafeInteger(periodId)||periodId<1) throw new Error('排班周期无效');
    url.searchParams.set('schedulePeriod',String(periodId));
  }
  return url.href;
}
export function readScheduleLink(search) {
  const params=new URLSearchParams(search), date=params.get('scheduleDate'), raw=params.get('schedulePeriod');
  const periodId=raw===null ? null : Number(raw);
  return validScheduleDate(date) && (raw===null || /^\d+$/.test(raw) && Number.isSafeInteger(periodId)&&periodId>0) ? {date,periodId} : null;
}
export function scheduleLines(date, day, periodName) {
  const lines=[{text:`${date} · 生效安排`,kind:'title'}];
  if (periodName) lines.push({text:periodName,kind:'note'});
  if (!day?.shifts?.some(s=>s.workTypes.length)) lines.push({text:'当天暂无安排',kind:'body'});
  for (const shift of day?.shifts || []) {
    lines.push({text:shift.shiftName,kind:'heading'});
    for (const work of shift.workTypes) {
      lines.push({text:work.workTypeName,kind:'work'});
      lines.push({text:work.assigned.length ? work.assigned.map(p=>`${p.name}${roles[p.dutyRole] ? `（${roles[p.dutyRole]}）` : ''}`).join('、') : '无人',kind:'body'});
      lines.push({text:work.gap ? `已排 ${work.filled} / ${work.needCount} · 缺 ${work.gap}` : work.fillAllEnrolled ? `已排 ${work.filled} · 最少 ${work.needCount}` : `已排 ${work.filled} / ${work.needCount}`,kind:'note'});
      if (work.roleGaps?.length) lines.push({text:`缺${work.roleGaps.map(r=>roles[r]||r).join('、')}`,kind:'note'});
    }
  }
  return lines;
}

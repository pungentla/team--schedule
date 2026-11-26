'use strict';
const db = require('../db/db');
const config = require('../repositories/configRepo');
const audit = require('../repositories/auditRepo');
const { isDateString, diffDays, nowIso } = require('../utils/date');
const { requireInt, requireArray, requireEnum } = require('../utils/validate');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');

function assignments(startDate, endDate) {
  return db.all(`SELECT c.id AS calendarId,c.work_date AS workDate,c.shift_id AS shiftId,c.work_type_id AS workTypeId,
    s.name AS shiftName,s.seq AS shiftSeq,s.start_time AS startTime,s.end_time AS endTime,
    w.name AS workTypeName,w.color AS workTypeColor,w.sort_order AS workOrder,p.user_id AS userId,p.duty_role AS dutyRole,u.display_name AS name
    FROM calendar_works c JOIN calendar_people p ON p.work_id=c.id JOIN users u ON u.id=p.user_id
    JOIN shifts s ON s.id=c.shift_id JOIN work_types w ON w.id=c.work_type_id
    WHERE c.work_date BETWEEN ? AND ? ORDER BY c.work_date,s.seq,w.sort_order,c.id,p.user_id`,startDate,endDate)
    .map(row=>({...row,id:`calendar:${row.calendarId}:${row.userId}`,periodId:null,periodName:'日历安排',source:'manual'}));
}
function view(startDate, endDate, user) {
  if (!isDateString(startDate) || !isDateString(endDate) || endDate<startDate || diffDays(startDate,endDate)>61) throw badRequest('请查看有效日期范围，一次最多62天');
  const days=new Map(), all=[];
  function add(day,shift,work) {
    if (!days.has(day)) days.set(day,new Map());
    const shifts=days.get(day);
    if (!shifts.has(shift.shiftId)) shifts.set(shift.shiftId,{...shift,workTypes:[]});
    shifts.get(shift.shiftId).workTypes.push(work);
  }
  const periods=db.all(`SELECT p.id FROM periods p JOIN schedule_runs r ON r.period_id=p.id AND r.status='published'
    WHERE p.deleted_at IS NULL AND p.start_date<=? AND p.end_date>=? ORDER BY p.start_date,p.id`,endDate,startDate);
  for (const {id} of periods) {
    const data=require('./scheduleService').getSchedule(id,user,{version:'published'});
    all.push(...data.assignments.filter(a=>a.workDate>=startDate && a.workDate<=endDate));
    for (const day of data.matrix.filter(d=>d.workDate>=startDate && d.workDate<=endDate)) for (const shift of day.shifts) {
      for (const work of shift.workTypes) add(day.workDate,shift,{...work,key:`period:${id}:${work.workTypeId}`,periodId:id});
    }
  }
  const manual=assignments(startDate,endDate), groups=new Map();
  for (const a of manual) {
    all.push(a);
    if (!groups.has(a.calendarId)) groups.set(a.calendarId,[]);
    groups.get(a.calendarId).push(a);
  }
  for (const [id,people] of groups) {
    const a=people[0];
    add(a.workDate,{shiftId:a.shiftId,shiftName:a.shiftName,shiftSeq:a.shiftSeq},{key:`calendar:${id}`,calendarId:id,
      workDate:a.workDate,shiftId:a.shiftId,workTypeId:a.workTypeId,workTypeName:a.workTypeName,workTypeColor:a.workTypeColor,
      needCount:people.length,filled:people.length,gap:0,roleGaps:[],assigned:people});
  }
  return {startDate,endDate,assignments:all,matrix:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([workDate,shifts])=>({workDate,shifts:[...shifts.values()].sort((a,b)=>a.shiftSeq-b.shiftSeq)}))};
}
function create(body, ctx) {
  if (!['admin','super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可新增日历安排');
  if (!isDateString(body.workDate)) throw badRequest('日期格式必须为YYYY-MM-DD');
  const shiftId=requireInt(body.shiftId,'班次',{min:1}),workTypeId=requireInt(body.workTypeId,'工作',{min:1});
  const people=requireArray(body.people,'人员',{min:1,max:99}).map(p=>({userId:requireInt(p?.userId,'人员',{min:1}),dutyRole:requireEnum(p?.dutyRole,'岗位',['member','primary','deputy'])}));
  if (new Set(people.map(p=>p.userId)).size!==people.length) throw badRequest('同一工作不能重复选择人员');
  return db.tx(()=>{
    const shift=config.findShift(shiftId),work=config.findWorkType(workTypeId);
    if (!shift?.active || !work?.active) throw badRequest('请选择启用的班次和工作');
    if (work.requires_roles ? people.length!==2 || !people.some(p=>p.dutyRole==='primary') || !people.some(p=>p.dutyRole==='deputy') : people.some(p=>p.dutyRole!=='member')) throw badRequest(work.requires_roles?'请选择一名主负责人和一名副负责人':'该工作请选择普通成员');
    for (const p of people) if (!db.get("SELECT id FROM users WHERE id=? AND status='active' AND role<>'super_admin'",p.userId)) throw badRequest('人员不存在、已停用或不参与排班');
    const existing=view(body.workDate,body.workDate,ctx.user).matrix.flatMap(d=>d.shifts).filter(s=>s.shiftId===shiftId).flatMap(s=>s.workTypes).find(w=>w.workTypeId===workTypeId);
    if (existing) throw conflict('CALENDAR_WORK_EXISTS','这一天的该班次已存在这项工作，请查看已有安排');
    const {lastInsertRowid:id}=db.run('INSERT INTO calendar_works(work_date,shift_id,work_type_id,created_by,created_at) VALUES(?,?,?,?,?)',body.workDate,shiftId,workTypeId,ctx.user.id,nowIso());
    for (const p of people) db.run('INSERT INTO calendar_people(work_id,user_id,duty_role) VALUES(?,?,?)',id,p.userId,p.dutyRole);
    audit.log({action:audit.ACTIONS.ASSIGNMENT_MANUAL,entityType:'calendar_work',entityId:Number(id),actorId:ctx.user.id,requestId:ctx.requestId,detail:{action:'calendar_work_added',workDate:body.workDate,shiftId,workTypeId,people}});
    return {id:Number(id)};
  });
}
function remove(id,ctx) {
  if (!['admin','super_admin'].includes(ctx.user?.role)) throw forbidden('仅管理员可移除日历安排');
  return db.tx(()=>{
    const work=db.get('SELECT * FROM calendar_works WHERE id=?',id);
    if (!work) throw notFound('日历安排不存在或已移除');
    audit.log({action:audit.ACTIONS.ASSIGNMENT_MANUAL,entityType:'calendar_work',entityId:id,actorId:ctx.user.id,requestId:ctx.requestId,detail:{action:'calendar_work_removed',...work,people:db.all('SELECT user_id,duty_role FROM calendar_people WHERE work_id=?',id)}});
    db.run('DELETE FROM calendar_works WHERE id=?',id);
    return {removed:true};
  });
}
module.exports={assignments,view,create,remove};

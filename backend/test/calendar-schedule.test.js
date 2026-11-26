'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
process.env.RATE_LIMIT_ENABLED='0';
const db=require('../src/db/db'),{migrate,truncateAll,CURRENT_VERSION}=require('../src/db/migrate');
const calendar=require('../src/services/calendarScheduleService'),schedule=require('../src/services/scheduleService');
const periodRepo=require('../src/repositories/periodRepo'),runRepo=require('../src/repositories/scheduleRepo'),config=require('../src/repositories/configRepo');
const {insertUser}=require('../src/repositories/userRepo'),{issueSession}=require('../src/services/authService'),{createApp}=require('../src/app');
let users,shift,work,roleWork,server,base;
test.before(async()=>{db.open(':memory:');migrate();server=createApp().listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}/api`;});
test.beforeEach(()=>{truncateAll();users=['admin','employee','employee','super_admin'].map((role,i)=>({id:insertUser({employeeNo:`CAL${i}`,name:`人员${i}`,passwordHash:'fixture',role}),role}));shift=config.insertShift({code:'AM',name:'早班',startTime:'08:00',endTime:'12:00',seq:1});work=config.insertWorkType({code:'WELCOME',name:'接待'});roleWork=config.insertWorkType({code:'LEAD',name:'带领',requiresRoles:true});});
test.after(()=>{server.close();db.close();});
const ctx=()=>({user:users[0]});
const body=(workDate='2026-11-08')=>({workDate,shiftId:shift,workTypeId:work,people:users.slice(1,3).map(u=>({userId:u.id,dutyRole:'member'}))});
async function request(path,{user=users[0],method='GET',body}={}){const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(user?{authorization:`Bearer ${issueSession(user.id).token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};}
test('无周期可新增过去与将来的安排，成员日历、本人和团队近期及历史轮转可见',()=>{
  calendar.create(body('2020-11-08'),ctx());calendar.create(body('2030-11-08'),ctx());
  assert.equal(db.pluck('SELECT COUNT(*) FROM periods'),0);
  const data=calendar.view('2020-11-01','2020-11-30',users[1]);
  assert.equal(data.matrix[0].workDate,'2020-11-08');assert.equal(data.matrix[0].shifts[0].workTypes[0].filled,2);
  const mine=schedule.getRecentSchedule(users[1].id,{startDate:'2020-11-01',endDate:'2020-11-30'});
  assert.equal(mine.assignments.length,1);assert.equal(mine.assignments[0].coworkers[0].userId,users[2].id);
  assert.equal(schedule.getTeamSchedule({startDate:'2030-11-08',days:1}).assignments.length,2);
  assert.equal(schedule.loadHistory('2026-01-01').get(users[1].id).total,1);
  assert.ok(!JSON.stringify(data).includes('CAL1'));
});
test('不能重复建同一工作，校验日期、停用项目、人员重复与主副岗位；失败不留半条记录',()=>{
  for(const b of [{...body(),workDate:'2026-02-30'},{...body(),shiftId:99999},{...body(),people:[body().people[0],body().people[0]]},{...body(),people:[{userId:users[3].id,dutyRole:'member'}]},{...body(),workTypeId:roleWork}])assert.throws(()=>calendar.create(b,ctx()),e=>e.status===400);
  assert.equal(db.pluck('SELECT COUNT(*) FROM calendar_works'),0);
  calendar.create(body(),ctx());assert.throws(()=>calendar.create(body(),ctx()),e=>e.code==='CALENDAR_WORK_EXISTS');
  assert.equal(db.pluck('SELECT COUNT(*) FROM calendar_people'),2);
  calendar.create({...body(),workTypeId:roleWork,people:[{userId:users[1].id,dutyRole:'primary'},{userId:users[2].id,dutyRole:'deputy'}]},ctx());
  assert.equal(calendar.view('2026-11-08','2026-11-08',users[1]).matrix[0].shifts[0].workTypes.length,2);
});
test('合并周期已发布与日历安排，草稿和删除周期不可见，周期原有工作不可重复新增',()=>{
  const periodId=periodRepo.insertPeriod({name:'周期',startDate:'2026-11-01',endDate:'2026-11-30',status:'published'});
  const runId=runRepo.insertRun({periodId,algoVersion:'test',seed:1,status:'published',totalNeeded:1,totalFilled:1,fillRate:1,metricsJson:null,gapsJson:null,rounds:0,durationMs:0,createdBy:users[0].id});
  periodRepo.insertSlot(periodId,'2026-11-08',shift);
  periodRepo.upsertRequirement(periodId,'2026-11-08',shift,work,1);
  runRepo.bulkInsertAssignments(runId,periodId,[{workDate:'2026-11-08',shiftId:shift,workTypeId:work,userId:users[1].id}]);
  assert.throws(()=>calendar.create(body(),ctx()),e=>e.code==='CALENDAR_WORK_EXISTS');
  calendar.create(body('2026-11-09'),ctx());
  assert.equal(calendar.view('2026-11-01','2026-11-30',users[1]).matrix.length,2);
  db.run('UPDATE periods SET deleted_at=? WHERE id=?',new Date().toISOString(),periodId);
  assert.equal(calendar.view('2026-11-01','2026-11-30',users[1]).matrix.length,1);
});
test('接口要求登录且仅管理员可增删，名单只返回展示名；移除仅影响独立安排并保留审计',async()=>{
  assert.equal((await request('/schedule/calendar?startDate=2026-11-01&endDate=2026-11-30',{user:null})).status,401);
  assert.equal((await request('/schedule/calendar',{user:users[1],method:'POST',body:body()})).status,403);
  assert.equal((await request('/schedule/calendar/people',{user:users[1]})).status,403);
  const people=(await request('/schedule/calendar/people')).body.data;assert.ok(people.every(p=>Object.keys(p).sort().join(',')==='id,name'));assert.ok(!people.some(p=>p.id===users[3].id));
  const result=await request('/schedule/calendar',{method:'POST',body:body()});assert.equal(result.status,201);const id=result.body.data.id;
  assert.equal((await request(`/schedule/calendar/${id}`,{user:users[1],method:'DELETE'})).status,403);
  assert.equal((await request(`/schedule/calendar/${id}`,{method:'DELETE'})).status,200);
  assert.equal(calendar.view('2026-11-08','2026-11-08',users[1]).matrix.length,0);
  assert.equal(db.pluck("SELECT COUNT(*) FROM audit_logs WHERE entity_type='calendar_work'"),2);
  assert.equal((await request('/schedule/calendar?startDate=2020-01-01&endDate=2030-01-01')).status,400);
});
test('v42升级不重算10分成绩或余额，不改变原有业务记录',()=>{
  const before=db.pluck('SELECT COUNT(*) FROM users');
  db.exec('DROP TABLE calendar_people;DROP TABLE calendar_works;PRAGMA user_version=42');
  assert.deepEqual(migrate(),{fromVersion:42,toVersion:CURRENT_VERSION});
  assert.equal(db.pluck('SELECT COUNT(*) FROM users'),before);assert.equal(db.all('PRAGMA foreign_key_check').length,0);assert.equal(db.get('PRAGMA quick_check').quick_check,'ok');
});

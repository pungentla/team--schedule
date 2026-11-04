'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'teamshift-admin-participation-'));
process.env.DB_FILE=path.join(tmp,'test.db');
const db=require('../src/db/db');
const {migrate,truncateAll}=require('../src/db/migrate');
const users=require('../src/repositories/userRepo');
const configs=require('../src/repositories/configRepo');
const configService=require('../src/services/configService');
const periods=require('../src/repositories/periodRepo');
const periodService=require('../src/services/periodService');
const enrollment=require('../src/services/enrollmentService');
const schedule=require('../src/services/scheduleService');
const swaps=require('../src/services/swapService');
const accounts=require('../src/services/accountService');
const {getPreparation}=require('../src/services/periodWorkflowService');
const {requireAdmin}=require('../src/middleware/auth');
let admin,superAdmin,employee,work,shift,period;
const ctx=(id=superAdmin)=>({user:users.publicUser(users.findById(id)),requestId:'participation-test'});
const sign=(id,dutyRole,extra={})=>enrollment.saveEnrollment(period,id,{workTypes:[{workTypeId:work,priority:1,dutyRole}],maxShifts:null,submit:true,...extra},ctx(id));
const generate=()=>schedule.generate(period,{seed:42},ctx());
const publish=(run)=>schedule.publish(period,run.runId,ctx());
const live=()=>schedule.getSchedule(period,ctx().user,{version:'published'});
test.beforeEach(()=>{
  migrate();truncateAll();
  [admin,superAdmin,employee]=['admin','super_admin','employee'].map((role)=>users.insertUser({employeeNo:role,name:role,passwordHash:'fixture',role}));
  shift=configs.insertShift({code:'DAY',name:'日班',startTime:'08:00',endTime:'12:00',seq:1});
  work=configs.insertWorkType({code:'DUTY',name:'主副值班',requiresRoles:true});
  period=periods.insertPeriod({name:'测试周期',startDate:'2026-11-05',endDate:'2026-11-05',status:'enrolling'});
  periods.insertSlot(period,'2026-11-05',shift);
  periodService.setRequirements(period,[{workDate:'2026-11-05',shiftId:shift,workTypeId:work,needCount:2}],ctx());
});
test.after(()=>{db.close();fs.rmSync(tmp,{recursive:true,force:true});});

test('管理员与超级管理员报名后进入主副排班、人员日表及统计，管理权限保留',()=>{
  sign(admin,'primary');sign(superAdmin,'deputy');
  const summary=enrollment.listEnrollments(period);
  assert.equal(summary.submittedCount,2);assert.equal(summary.effectiveCount,2);assert.equal(summary.totalEmployees,3);
  assert.equal(getPreparation(period).participants.length,2);
  const run=generate();assert.equal(run.assignments.length,2);publish(run);
  const data=live();assert.ok(data.employees.some(u=>u.id===admin));assert.ok(data.employees.some(u=>u.id===superAdmin));
  assert.equal(data.metrics.workload.distribution.length,2);
  for(const id of [admin,superAdmin]){
    assert.equal(schedule.getMyAssignments(id).length,1);
    let denied;requireAdmin({user:ctx(id).user},{},err=>{denied=err;});assert.equal(denied,undefined);
  }
  assert.equal(schedule.getDashboard().employeeCount,3);assert.equal(schedule.getDashboard().enrollment.submitted,2);
});
test('长期固定名单允许管理员和超级管理员，无需重复报名',()=>{
  configService.updateWorkType(work,{weekdays:[4],weeklyAssignments:[{weekday:4,shiftId:shift,userId:admin,dutyRole:'primary'},{weekday:4,shiftId:shift,userId:superAdmin,dutyRole:'deputy'}]},ctx());
  const ready=getPreparation(period);assert.equal(ready.fixedCount,2);assert.equal(ready.submittedCount,0);assert.equal(ready.canGenerate,true);
  assert.equal(enrollment.getEnrollContext(period,superAdmin).fixedAssignments.length,1);
  const run=generate();assert.ok(run.assignments.every(a=>a.isFixed));publish(run);
  assert.equal(live().assignments.length,2);
});
test('未报名的管理员不自动获得工作资格，手工调配也遵守报名范围',()=>{
  configService.updateWorkType(work,{requiresRoles:false,defaultNeed:1},ctx());
  periodService.setRequirements(period,[{workDate:'2026-11-05',shiftId:shift,workTypeId:work,needCount:1}],ctx());
  sign(employee,'member');const run=generate();assert.deepEqual(run.assignments.map(a=>a.userId),[employee]);
  const target=schedule.getSchedule(period,ctx().user,{version:'draft'}).assignments[0];
  const candidates=schedule.getDraftCandidates(run.runId,{assignmentId:target.id});
  for(const id of [admin,superAdmin])assert.equal(candidates.candidates.find(u=>u.userId===id).canAssign,false);
  publish(run);
  assert.throws(()=>swaps.reassignByAdmin({type:'transfer',fromAssignmentId:target.id,toUserId:admin},ctx()),e=>e.code==='SWAP_CONFLICT');
});
test('管理员仍遵守主副资格、个人上限和请假，停用后退出有效候选与报名统计',()=>{
  sign(superAdmin,'deputy');
  for(const extra of [{maxShifts:0},{unavailability:[{workDate:'2026-11-05',reason:'请假'}]}]){
    sign(admin,'primary',extra);const run=generate();assert.ok(!run.assignments.some(a=>a.userId===admin));
    assert.throws(()=>publish(run),e=>e.code==='ROLE_COVERAGE_MISSING');
  }
  sign(admin,'primary');const run=generate();publish(run);
  const primary=live().assignments.find(a=>a.userId===admin);
  assert.ok(swaps.precheckTransfer({period:periods.findPeriod(period),assignment:require('../src/repositories/scheduleRepo').findAssignment(primary.id),toUserId:superAdmin}).some(p=>p.code==='role_mismatch'));
  users.updateUser(admin,{status:'disabled'});
  assert.ok(!enrollment.getEffectiveEnrollments(period).some(e=>e.userId===admin));
  const summary=enrollment.listEnrollments(period);assert.equal(summary.totalEmployees,2);assert.equal(summary.submittedCount,1);
});
test('员工晋升管理员后，已有报名与草稿资格保留，不改变账号管理权限边界',()=>{
  sign(employee,'primary');sign(admin,'deputy');const run=generate();
  accounts.update(employee,{role:'admin'},ctx());
  assert.ok(enrollment.getEffectiveEnrollments(period).some(e=>e.userId===employee));publish(run);
  assert.equal(schedule.getMyAssignments(employee).length,1);
  assert.throws(()=>accounts.update(superAdmin,{name:'越权修改'},ctx(employee)),e=>e.status===403);
});
test('管理员可以发起并确认自己的换班，也可以被直接调配',()=>{
  periods.updatePeriod(period,{endDate:'2026-11-06'});
  configService.updateWorkType(work,{requiresRoles:false,defaultNeed:1,weekdays:[4,5],weeklyAssignments:[{weekday:4,shiftId:shift,userId:admin,dutyRole:'member'},{weekday:5,shiftId:shift,userId:superAdmin,dutyRole:'member'}]},ctx());
  periodService.generateSlots(period,{defaultNeed:0},ctx());periodService.applyWorkRules(period,ctx());publish(generate());
  const source=live().assignments.find(a=>a.userId===admin);
  assert.ok(swaps.listCandidates(source.id,ctx(admin).user).candidates.some(u=>u.userId===superAdmin&&u.canTake));
  const request=swaps.createSwap({type:'transfer',fromAssignmentId:source.id,toUserId:superAdmin},ctx(admin));
  assert.equal(request.swap.status,'pending');swaps.confirm(request.swap.id,ctx());
  assert.equal(schedule.getMyAssignments(admin).length,0);assert.equal(schedule.getMyAssignments(superAdmin).length,2);
  const taken=live().assignments.find(a=>a.workDate==='2026-11-05');
  swaps.reassignByAdmin({type:'transfer',fromAssignmentId:taken.id,toUserId:admin},ctx());
  assert.equal(schedule.getMyAssignments(admin).length,1);assert.equal(live().assignments.length,2);
});

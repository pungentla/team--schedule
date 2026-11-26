'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), { once } = require('node:events');
process.env.RATE_LIMIT_ENABLED = '0';
const db = require('../src/db/db'), { migrate, truncateAll } = require('../src/db/migrate');
const { insertUser } = require('../src/repositories/userRepo'), { issueSession } = require('../src/services/authService');
const { createApp } = require('../src/app'), wishes = require('../src/services/wishService'), harvest = require('../src/services/harvestService');
let users, server, base, tokens;
test.before(async () => { db.open(':memory:'); migrate(); server = createApp().listen(0,'127.0.0.1'); await once(server,'listening'); base=`http://127.0.0.1:${server.address().port}/api`; });
test.beforeEach(() => { truncateAll(); users = ['employee','employee','super_admin'].map((role,i)=>({ id:insertUser({ employeeNo:`WISH${i}`, name:`许愿者${i}`, passwordHash:'fixture', role }),role })); tokens=users.map(u=>issueSession(u.id).token); });
test.after(() => { server.close(); db.close(); });
function earn(index,amount) { db.run('INSERT INTO playground_harvest(user_id,source_key,game,amount,reason,created_at) VALUES(?,?,?,?,?,?)',users[index].id,randomUUID(),'quiz',amount,'测试游戏收获',new Date().toISOString()); }
async function request(path,{ user=0, method='GET', body }={}) { const response=await fetch(base+path,{method,headers:{...(user===null?{}:{Authorization:`Bearer ${tokens[user]}`}), 'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=response.status===204?null:await response.json();return {status:response.status,body:result}; }
test('30禾穗兑换候选愿望，内容和作者由服务器确定，消费在本人记录中展示', async () => {
  assert.equal((await request('/playground/wishes')).body.data.cost,30);
  earn(0,45);const body={requestKey:randomUUID(),presetId:'hello',cost:0,userId:users[1].id};
  const result=await request('/playground/wishes',{method:'POST',body});assert.equal(result.status,201);assert.equal(result.body.data.cost,30);assert.equal(result.body.data.balance,15);
  const topic=(await request(`/discussions/${result.body.data.topicId}`)).body.data;assert.equal(topic.category,'wish');assert.equal(topic.wishOrigin,'playground');assert.equal(topic.wishCost,30);assert.equal(topic.authorName,'许愿者0');assert.equal(topic.anonymous,0);assert.match(topic.content,/不保证实现/);
  assert.match(topic.wishContent,/热情地打个招呼/);
  const list=harvest.list(users[0]);assert.equal(list.total,2);assert.equal(list.balance,15);assert.equal(list.items.find(i=>i.game==='wish').amount,-30);assert.equal(harvest.list(users[1]).balance,0);
  assert.equal((await request('/discussions?category=wish')).body.data.total,1);assert.equal((await request('/discussions?category=chat')).body.data.total,0);
});
test('29禾穗不能兑换，刚好30禾穗可兑换且余额为零', () => {
  earn(0,29);
  const body={requestKey:randomUUID(),presetId:'hello',cost:10};
  assert.throws(()=>wishes.create(users[0],body),e=>e.code==='HARVEST_NOT_ENOUGH');
  assert.equal(harvest.balance(users[0].id),29);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_topics'),0);
  earn(0,1);const result=wishes.create(users[0],body);
  assert.equal(result.cost,30);assert.equal(result.balance,0);
});
test('请求幂等、正文变化拒绝、连续许愿不会透支，删除话题也不能退币或重复兑换', async () => {
  earn(0,35); const body={requestKey:randomUUID(),presetId:'custom',title:'一起吃午饭',content:'想找伙伴一起聊天。'};
  const results=await Promise.all([request('/playground/wishes',{method:'POST',body}),request('/playground/wishes',{method:'POST',body})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
  const id=results[0].body.data.topicId;assert.equal(results[1].body.data.topicId,id);assert.equal(harvest.balance(users[0].id),5);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_topics'),1);
  assert.equal((await request('/playground/wishes',{method:'POST',body:{...body,title:'换一个愿望'}})).status,409);
  assert.equal((await request('/playground/wishes',{method:'POST',body:{...body,requestKey:randomUUID()}})).status,409);
  assert.equal((await request(`/discussions/${id}`,{method:'DELETE'})).status,200);assert.equal(harvest.balance(users[0].id),5);
  const retry=await request('/playground/wishes',{method:'POST',body});assert.equal(retry.status,200);assert.equal(retry.body.data.topicId,null);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_topics'),0);assert.equal(db.pluck('SELECT COUNT(*) FROM playground_wishes'),1);
});
test('余额不足与无效输入不扣除；发帖或兑换存储失败会完整回滚', () => {
  assert.throws(()=>wishes.create(users[0],{requestKey:randomUUID(),presetId:'hello'}),e=>e.code==='HARVEST_NOT_ENOUGH');
  earn(0,30);
  for(const body of [{presetId:'hello',requestKey:'bad'},{presetId:'other',requestKey:randomUUID()},{presetId:'custom',title:' ',requestKey:randomUUID()},{presetId:'custom',title:'a'.repeat(61),requestKey:randomUUID()},{presetId:'hello',content:'a'.repeat(1001),requestKey:randomUUID()}])assert.throws(()=>wishes.create(users[0],body),e=>e.status===400);
  db.exec("CREATE TRIGGER fail_wish BEFORE INSERT ON playground_wishes BEGIN SELECT RAISE(ABORT,'storage failure'); END;");
  try { assert.throws(()=>wishes.create(users[0],{requestKey:randomUUID(),presetId:'hello'}),/storage failure/); } finally {db.exec('DROP TRIGGER fail_wish');}
  assert.equal(harvest.balance(users[0].id),30);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_topics'),0);assert.equal(db.pluck('SELECT COUNT(*) FROM playground_wishes'),0);
});
test('许愿入口鉴权，普通发帖不能伪造许愿类型或来源标签，仍支持点赞评论和未读提醒', async () => {
  for(const method of ['GET','POST'])assert.equal((await request('/playground/wishes',{user:null,method,...(method==='POST'?{body:{}}:{})})).status,401);
  assert.equal((await request('/playground/wishes',{user:2})).status,403);
  assert.equal((await request('/discussions',{method:'POST',body:{category:'wish',title:'直接许愿',content:'绕过扣除'}})).status,403);
  const normal=await request('/discussions',{method:'POST',body:{category:'chat',title:'普通话题',content:'正文',wishOrigin:'playground',wishCost:30}});
  assert.equal((await request(`/discussions/${normal.body.data.id}`)).body.data.category,'chat');
  earn(0,30);const result=await request('/playground/wishes',{method:'POST',body:{requestKey:randomUUID(),presetId:'encourage'}}),id=result.body.data.topicId;
  assert.equal((await request(`/discussions/${id}/like`,{method:'PUT',user:1,body:{liked:true}})).status,200);
  assert.equal((await request(`/discussions/${id}/replies`,{method:'POST',user:1,body:{content:'愿你今天有力量！'}})).status,201);
  assert.equal((await request('/discussions/unread-replies')).body.data.find(t=>t.id===id).unreadCount,1);
  assert.equal((await request('/discussions?category=wish&sort=hot')).body.data.items[0].likeCount,1);
});
test('v39升级保留已有账户、收获、话题和回复，新建兑换表但不消费已有禾穗', () => {
  earn(0,20);const id=db.run("INSERT INTO discussion_topics(author_id,category,title,content,created_at) VALUES(?,'chat','原有话题','正文','now')",users[0].id).lastInsertRowid;
  db.run('INSERT INTO discussion_replies(topic_id,author_id,content,created_at) VALUES(?,?,?,?)',id,users[1].id,'原回复','now');
  db.exec('DROP TABLE playground_wishes; PRAGMA user_version=39;');assert.deepEqual(migrate(),{fromVersion:39,toVersion:43});
  assert.equal(harvest.balance(users[0].id),20);assert.equal(db.pluck('SELECT COUNT(*) FROM users'),3);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id=?',id),1);assert.equal(db.all('PRAGMA foreign_key_check').length,0);assert.equal(db.get('PRAGMA quick_check').quick_check,'ok');
});
test('v40升级保留10禾穗旧消费、话题关联和请求去重，新兑换收取30禾穗', () => {
  earn(0,50);
  const topicId=db.run("INSERT INTO discussion_topics(author_id,category,title,content,created_at) VALUES(?,'chat','旧愿望','旧说明','now')",users[0].id).lastInsertRowid;
  db.run('INSERT INTO discussion_replies(topic_id,author_id,content,created_at) VALUES(?,?,?,?)',topicId,users[1].id,'旧回复','now');
  const legacy=db.readSchemaSql().match(/CREATE TABLE IF NOT EXISTS playground_wishes \([\s\S]*?\);/)[0].replace('DEFAULT 30 CHECK (cost IN (10, 30))','DEFAULT 10 CHECK (cost = 10)');
  db.exec('DROP TABLE playground_wishes');db.exec(legacy);
  const requestKey=randomUUID();db.run('INSERT INTO playground_wishes(id,user_id,request_key,title,content,cost,topic_id,created_at) VALUES(?,?,?,?,?,10,?,?)',randomUUID(),users[0].id,requestKey,'旧愿望','旧说明',topicId,new Date().toISOString());
  db.exec('PRAGMA user_version=40');assert.deepEqual(migrate(),{fromVersion:40,toVersion:43});
  assert.equal(harvest.balance(users[0].id),40);assert.equal(db.pluck('SELECT COUNT(*) FROM discussion_replies WHERE topic_id=?',topicId),1);
  const old=wishes.create(users[0],{requestKey,presetId:'custom',title:'旧愿望',content:'旧说明'});
  assert.equal(old.cost,10);assert.equal(old.balance,40);assert.equal(old.topicId,Number(topicId));assert.equal(old.replayed,true);
  const current=wishes.create(users[0],{requestKey:randomUUID(),presetId:'hello'});assert.equal(current.cost,30);assert.equal(current.balance,10);
  assert.equal(db.get("SELECT tbl_name FROM sqlite_master WHERE name='idx_playground_wishes_user'").tbl_name,'playground_wishes');
  assert.equal(db.all('PRAGMA foreign_key_check').length,0);assert.equal(db.get('PRAGMA quick_check').quick_check,'ok');
  assert.deepEqual(migrate(),{fromVersion:43,toVersion:43});
});

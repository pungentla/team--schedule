'use strict';

const { ECDH } = require('node:crypto');
const webPush = require('web-push');
const db = require('../db/db');
const { config } = require('../config');
const { addDays, nowTime, today } = require('../utils/date');
const { badRequest } = require('../utils/errors');
const { getTeamSchedule } = require('./scheduleService');

const vapidDetails = config.webPush;
const publicKey = vapidDetails.subject && vapidDetails.publicKey && vapidDetails.privateKey
  ? vapidDetails.publicKey : null;

// 订阅由浏览器生成，只向受支持的推送服务发送请求。
const pushHost = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|[a-z0-9-]+\.push\.apple\.com)$/;

function validateEndpoint(endpoint) {
  if (typeof endpoint === 'string' && endpoint.length <= 4096) {
    const url = URL.parse(endpoint);
    if (url?.protocol === 'https:' && pushHost.test(url.hostname) && !url.port &&
      !url.username && !url.password && !url.hash && url.href === endpoint && url.pathname !== '/') return endpoint;
  }
  throw badRequest('此浏览器的通知订阅地址无效或暂不支持');
}

function keyBytes(value, length) {
  const bytes = typeof value === 'string' && value.length <= 88 ? Buffer.from(value, 'base64url') : null;
  if (bytes?.length !== length || bytes.toString('base64url') !== value) throw badRequest('通知订阅密钥无效');
  return bytes;
}

function findSubscription(userId, endpoint) {
  return db.get('SELECT * FROM push_subscriptions WHERE user_id=? AND endpoint=?', userId, endpoint);
}

function saveSubscription(userId, { endpoint, keys } = {}) {
  endpoint = validateEndpoint(endpoint);
  const point = keyBytes(keys?.p256dh, 65);
  keyBytes(keys?.auth, 16);
  try { ECDH.convertKey(point, 'prime256v1'); }
  catch { throw badRequest('通知订阅密钥无效'); }
  db.run(`INSERT INTO push_subscriptions (endpoint,user_id,p256dh,auth) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      reminded_date=CASE WHEN user_id=excluded.user_id THEN reminded_date END,
      user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`, endpoint, userId, keys.p256dh, keys.auth);
}

function removeSubscription(userId, endpoint) {
  db.run('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', userId, endpoint);
}

async function sendDevice(device, payload, ttl) {
  const { endpoint, p256dh, auth, user_id: userId } = device;
  try {
    await webPush.sendNotification({ endpoint, keys: { p256dh, auth } }, JSON.stringify(payload), {
      vapidDetails, TTL: ttl, timeout: 10_000,
    });
    return true;
  } catch (error) {
    if (error.statusCode !== 404 && error.statusCode !== 410) throw error;
    db.run('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND p256dh=? AND auth=?', endpoint, userId, p256dh, auth);
    return false;
  }
}

function sendTest(device) {
  return sendDevice(device, { title: '时禾 · 测试通知', body: '这台设备已能接收排班提醒。', tag: 'shihe-test' }, 120);
}

async function sendScheduleReminders(workDate, stopped = () => false) {
  const devices = db.all(`SELECT s.* FROM push_subscriptions s JOIN users u ON u.id=s.user_id
    WHERE u.status='active' AND s.reminded_date IS NOT ?`, workDate);
  if (!devices.length) return;
  const counts = new Map();
  for (const { userId } of getTeamSchedule({ startDate: workDate, days: 1 }).assignments) {
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }
  for (const device of devices) {
    if (stopped()) break;
    const count = counts.get(device.user_id);
    if (!count || !findSubscription(device.user_id, device.endpoint)) continue;
    try {
      const sent = await sendDevice(device, {
        title: '时禾 · 排班提醒', body: `${workDate} 有 ${count} 项排班，打开时禾查看。`, tag: `shihe-${workDate}`,
      }, 6 * 3600);
      if (sent) db.run('UPDATE push_subscriptions SET reminded_date=? WHERE user_id=? AND endpoint=?', workDate, device.user_id, device.endpoint);
    } catch (error) {
      console.warn('[reminders] push failed:', error.statusCode || error.code || 'network error');
    }
  }
}

function startScheduleReminders() {
  if (!publicKey) return () => {};
  let busy = false;
  let stopped = false;
  async function tick() {
    if (busy || nowTime() < '18:00:00') return;
    busy = true;
    try { await sendScheduleReminders(addDays(today(), 1), () => stopped); }
    catch (error) { console.error('[reminders] dispatch failed:', error.message); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, 60_000).unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { publicKey, validateEndpoint, findSubscription, saveSubscription, removeSubscription, sendTest, sendScheduleReminders, startScheduleReminders };

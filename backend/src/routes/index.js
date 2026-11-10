'use strict';

/** 路由总装 */

const express = require('express');
const os = require('node:os');
const db = require('../db/db');
const { config } = require('../config');

const authRoutes = require('./auth');
const workTypeRoutes = require('./workTypes');
const shiftRoutes = require('./shifts');
const periodRoutes = require('./periods');
const enrollmentRoutes = require('./enrollments');
const scheduleRoutes = require('./schedule');
const swapRoutes = require('./swaps');
const statsRoutes = require('./stats');
const adminRoutes = require('./admin');
const announcementRoutes = require('./announcements');
const discussionRoutes = require('./discussions');
const reminderRoutes = require('./reminders');

const { requireAuth, requireAdmin } = require('../middleware/auth');

/** 取本机所有非回环 IPv4 地址（真机调试要连局域网 IP） */
function localIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

const router = express.Router();

router.get('/health', (req, res) => {
  const sqliteVersion = db.pluck('SELECT sqlite_version()');
  res.json({
    data: {
      ok: true,
      service: 'teamshift-backend',
      version: config.algoVersion,
      sqliteVersion,
      time: new Date().toISOString(),
      // 局域网地址：小程序真机调试时用来发现后端，免去手改代码
      lanUrls: localIps().map((ip) => `http://${ip}:${config.port}`),
    },
  });
});

router.use('/auth', authRoutes);
router.use('/work-types', workTypeRoutes);
router.use('/shifts', shiftRoutes);
router.use('/periods', periodRoutes);
router.use('/enrollments', enrollmentRoutes);
router.use('/schedule', scheduleRoutes);
router.use('/swaps', swapRoutes);
router.use('/stats', statsRoutes);
router.use('/announcements', announcementRoutes);
router.use('/discussions', discussionRoutes);
router.use('/reminders', reminderRoutes);
router.use('/admin', requireAuth, requireAdmin, adminRoutes);

module.exports = router;

'use strict';

/** 服务入口 */

const os = require('node:os');
const { createApp } = require('./app');
const { config } = require('./config');
const { migrate } = require('./db/migrate');
const db = require('./db/db');

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

function main() {
  // 启动时自动建表（幂等）
  const { fromVersion, toVersion } = migrate();
  if (fromVersion !== toVersion) {
    console.log(`[db] 已迁移 schema: v${fromVersion} -> v${toVersion}`);
  }

  const app = createApp();

  const server = app.listen(config.port, config.host, () => {
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║        排班宝 TeamShift 后端已启动             ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log(`  本机访问:   http://127.0.0.1:${config.port}/api/health`);
    for (const ip of localIps()) {
      console.log(`  局域网访问: http://${ip}:${config.port}/api   (真机调试用这个)`);
    }
    console.log(`  数据库:     ${config.dbFile}`);
    console.log(`  算法版本:   ${config.algoVersion}`);
    console.log('');
  });

  const shutdown = (signal) => {
    console.log(`\n[server] 收到 ${signal}，正在关闭...`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();

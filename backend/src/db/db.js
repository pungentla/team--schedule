'use strict';

/**
 * 数据库驱动层 —— 全项目唯一直接接触 node:sqlite 的文件。
 *
 * node:sqlite 的已知坑（均已实测）：
 *  1. 每条连接默认 foreign_keys=OFF → 打开后必须立即 PRAGMA foreign_keys=ON
 *  2. 不支持绑定 undefined / boolean / bigint → 会抛 ERR_SQLITE_ERROR "cannot be bound"
 *     对策：normalizeParams() 统一规整为 null / 0,1 / Number
 *  3. 没有 db.transaction() → 自实现 tx()，支持嵌套（用 SAVEPOINT）
 *  4. DatabaseSync 只支持同步 API，不需要 await
 *
 * 未来若换 better-sqlite3，只需改这一个文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');

let db = null;
let txDepth = 0;

/**
 * 值规整：把 JS 值转成 node:sqlite 能绑定的类型。
 * undefined → null（SQL NULL），boolean → 0/1，bigint → Number，Date → ISO
 */
function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === 'boolean') return value ? 1 : 0;
  if (t === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (t === 'object') return JSON.stringify(value);
  return value;
}

/** 参数规整：支持 (a, b) 与 ([a, b]) 两种调用风格 */
function normalizeParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0].map(normalizeValue);
  }
  return params.map(normalizeValue);
}

/** 打开连接并应用必要 PRAGMA */
function open(dbFile = config.dbFile) {
  if (db) return db;

  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = new DatabaseSync(dbFile);

  db.exec('PRAGMA foreign_keys = ON');     // 外键约束（默认关闭，必须显式开）
  db.exec('PRAGMA journal_mode = WAL');    // 并发读 + 单写
  db.exec('PRAGMA busy_timeout = 3000');   // 写锁等待 3 秒而非立刻报错
  db.exec('PRAGMA synchronous = NORMAL');  // WAL 下的安全/性能平衡

  return db;
}

/** 获取连接（懒加载） */
function getDb() {
  return db || open();
}

/** 执行写语句，返回 {changes, lastInsertRowid} */
function run(sql, ...params) {
  const stmt = getDb().prepare(sql);
  const result = stmt.run(...normalizeParams(params));
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

/** 查询单行，无结果返回 undefined */
function get(sql, ...params) {
  const stmt = getDb().prepare(sql);
  return stmt.get(...normalizeParams(params));
}

/** 查询多行 */
function all(sql, ...params) {
  const stmt = getDb().prepare(sql);
  return stmt.all(...normalizeParams(params));
}

/** 查询单值（第一行第一列），无结果返回 undefined */
function pluck(sql, ...params) {
  const row = get(sql, ...params);
  if (!row) return undefined;
  return Object.values(row)[0];
}

/**
 * 事务包装。已实测 exec('BEGIN')/COMMIT/ROLLBACK 正常。
 * 支持嵌套调用（内层用 SAVEPOINT，避免 "cannot start a transaction within a transaction"）。
 */
function tx(fn) {
  const database = getDb();
  const savepoint = txDepth > 0 ? `sp_${txDepth}` : null;

  if (savepoint) {
    database.exec(`SAVEPOINT ${savepoint}`);
  } else {
    database.exec('BEGIN');
  }
  txDepth += 1;

  try {
    const result = fn();
    txDepth -= 1;
    if (savepoint) {
      database.exec(`RELEASE ${savepoint}`);
    } else {
      database.exec('COMMIT');
    }
    return result;
  } catch (err) {
    txDepth -= 1;
    if (savepoint) {
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
    } else {
      try {
        database.exec('ROLLBACK');
      } catch {
        // 连接已回滚或断开，忽略
      }
    }
    throw err;
  }
}

/** 执行多语句 SQL（建表等） */
function exec(sql) {
  getDb().exec(sql);
}

/** 当前事务深度（测试用） */
function transactionDepth() {
  return txDepth;
}

/** 关闭连接 */
function close() {
  if (db) {
    db.close();
    db = null;
    txDepth = 0;
  }
}

/** 读取 schema.sql 全文 */
function readSchemaSql() {
  return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
}

module.exports = {
  open,
  getDb,
  run,
  get,
  all,
  pluck,
  tx,
  exec,
  close,
  transactionDepth,
  readSchemaSql,
  normalizeValue,
};

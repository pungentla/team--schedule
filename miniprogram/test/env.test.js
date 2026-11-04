/**
 * 服务器地址解析逻辑测试
 *
 * 在 Node 里模拟 wx 全局对象，真实验证 env.js 的行为。
 * 这段逻辑直接决定「真机能不能连上后端」，出错会导致整机不可用，所以单独测。
 *
 * 运行：node miniprogram/test/env.test.js
 */
const path = require('node:path');
const ENV_PATH = path.join(__dirname, '..', 'config', 'env.js');

function makeWx(opts = {}) {
  const storage = {};
  return {
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    getSystemInfoSync: () => ({ platform: opts.platform || 'devtools' }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: opts.envVersion || 'develop', appId: 'wx2503b1cfbc7a04a0' } }),
    request: () => {},
    __storage: storage,
  };
}

function load(wxObj) {
  global.wx = wxObj;
  delete require.cache[require.resolve(ENV_PATH)];
  return require(ENV_PATH);
}

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}  →  ${JSON.stringify(actual)}${ok ? '' : '  (期望 ' + JSON.stringify(expected) + ')'}`);
}

console.log('\n【normalizeUrl 地址规整】');
const m = load(makeWx());
eq('纯 IP 补协议和端口', m.normalizeUrl('192.168.1.5'), 'http://192.168.1.5:3000');
eq('IP:端口 补协议', m.normalizeUrl('192.168.1.5:3000'), 'http://192.168.1.5:3000');
eq('完整 http 原样', m.normalizeUrl('http://10.0.0.8:3000'), 'http://10.0.0.8:3000');
eq('https 域名不补 443（避免 SNI/代理问题）', m.normalizeUrl('https://example.com'), 'https://example.com');
eq('末尾斜杠去掉', m.normalizeUrl('http://a.com:3000/'), 'http://a.com:3000');
eq('空值返回空串', m.normalizeUrl('  '), '');

// 穿透/线上域名的关键场景：纯域名必须走 https，且不能补 :443
eq('https 域名不补端口', m.normalizeUrl('https://abc.trycloudflare.com'), 'https://abc.trycloudflare.com');
eq('纯域名自动升级 https', m.normalizeUrl('abc.trycloudflare.com'), 'https://abc.trycloudflare.com');
eq('ngrok 域名', m.normalizeUrl('https://abc.ngrok-free.app'), 'https://abc.ngrok-free.app');
eq('显式端口保留', m.normalizeUrl('https://api.example.com:8443'), 'https://api.example.com:8443');
eq('localhost 走 http', m.normalizeUrl('localhost:3000'), 'http://localhost:3000');
eq('纯 IP 无端口补 3000', m.normalizeUrl('10.0.0.8'), 'http://10.0.0.8:3000');

console.log('\n【getBaseUrl 优先级】');
// 1. 开发者工具、无自定义 → DEV_URL
let w = makeWx({ platform: 'devtools' });
let e = load(w);
eq('开发者工具默认连本机', e.getBaseUrl(), 'http://127.0.0.1:3000');

// 2. 手动设置优先
w = makeWx({ platform: 'devtools' });
e = load(w);
e.setBaseUrl('http://192.168.1.9:3000');
eq('手动设置优先级最高', e.getBaseUrl(), 'http://192.168.1.9:3000');

// 3. 真机 + 缓存过局域网地址
w = makeWx({ platform: 'ios' });
e = load(w);
e.setLanBaseUrl('http://192.168.1.7:3000');
eq('真机用缓存的局域网地址', e.getBaseUrl(), 'http://192.168.1.7:3000');

// 4. 真机 + 无缓存 → 回退 DEV_URL（由登录页引导设置）
w = makeWx({ platform: 'ios' });
e = load(w);
eq('真机无缓存时回退（登录页会引导）', e.getBaseUrl(), 'http://127.0.0.1:3000');

// 5. 正式版 + 无 PROD_URL → 不应崩溃
w = makeWx({ envVersion: 'release', platform: 'ios' });
e = load(w);
eq('正式版无 PROD_URL 时不崩溃', typeof e.getBaseUrl(), 'string');

console.log('\n【环境识别】');
w = makeWx({ envVersion: 'release' });
e = load(w);
eq('识别正式版', e.getEnvInfo().envVersion, 'release');
w = makeWx({ platform: 'devtools' });
e = load(w);
eq('识别开发者工具', e.isDevtools(), true);
w = makeWx({ platform: 'android' });
e = load(w);
eq('识别真机', e.isDevtools(), false);

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

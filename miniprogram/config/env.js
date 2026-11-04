/**
 * 服务器地址配置。
 *
 * 微信小程序的 wx.request 在真机/线上只能访问「合法域名」（必须 HTTPS + ICP 备案）。
 * 三种典型场景：
 *
 *   1. 开发者工具模拟器  → http://127.0.0.1:3000 可用（需勾选「不校验合法域名」）
 *   2. 真机预览/调试      → 手机和电脑在同一 WiFi，用电脑的局域网 IP，如 http://192.168.1.5:3000
 *   3. 正式版（release）  → 必须是 HTTPS + 备案域名，且在小程序后台配置 request 合法域名
 *
 * 优先级：用户手动设置 > 正式环境 PROD_URL > 开发者工具用 DEV_URL > 真机尝试 LAN 探测
 */

// 本机模拟器 / 开发者工具
const DEV_URL = 'http://127.0.0.1:3000';

// 线上环境（部署后端后填写，必须 HTTPS 且已备案）
const PROD_URL = '';

/**
 * 获取运行环境信息（安全兜底：老版本基础库可能没有 getAccountInfoSync）
 */
function getEnvInfo() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const mp = (info && info.miniProgram) || {};
    return {
      envVersion: mp.envVersion || 'develop', // develop / trial / release
      appId: mp.appId || '',
    };
  } catch (e) {
    return { envVersion: 'develop', appId: '' };
  }
}

/** 是否在开发者工具里（工具里可直连 127.0.0.1） */
function isDevtools() {
  try {
    const sys = wx.getSystemInfoSync();
    return sys.platform === 'devtools';
  } catch (e) {
    return false;
  }
}

function getBaseUrl() {
  // 1. 用户手动设置优先（长按 logo 3 秒可设置）
  const custom = wx.getStorageSync('baseUrl');
  if (custom) return custom;

  const { envVersion } = getEnvInfo();

  // 2. 正式版必须走线上地址
  if (envVersion === 'release' && PROD_URL) return PROD_URL;

  // 3. 开发者工具直连本机
  if (isDevtools()) return DEV_URL;

  // 4. 真机：用之前探测到的局域网地址
  const cached = wx.getStorageSync('lanBaseUrl');
  if (cached) return cached;

  // 5. 都没有 → 回退到 DEV_URL，并由上层引导用户设置
  return DEV_URL;
}

function setBaseUrl(url) {
  if (url) wx.setStorageSync('baseUrl', url.replace(/\/+$/, ''));
  else wx.removeStorageSync('baseUrl');
}

function setLanBaseUrl(url) {
  if (url) wx.setStorageSync('lanBaseUrl', url.replace(/\/+$/, ''));
}

/**
 * 探测可用的局域网后端地址。
 *
 * 真机上 127.0.0.1 指向手机自己，必然失败；而电脑 IP 我们无法直接得知，
 * 所以这里让用户输入"电脑的局域网 IP 或整个地址"，或从常见网段探测。
 *
 * @param {string[]} candidates 候选地址列表
 * @returns {Promise<string|null>} 第一个可用的地址
 */
function probeBaseUrls(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    let index = 0;
    let settled = false;

    const tryNext = () => {
      if (settled) return;
      if (index >= list.length) {
        settled = true;
        resolve(null);
        return;
      }
      const url = list[index++];
      wx.request({
        url: `${url}/api/health`,
        method: 'GET',
        timeout: 2500,
        success(res) {
          if (settled) return;
          if (res.statusCode === 200 && res.data && res.data.data && res.data.data.ok) {
            settled = true;
            resolve(url);
          } else {
            tryNext();
          }
        },
        fail() {
          tryNext();
        },
      });
    };

    tryNext();
  });
}

/**
 * 把用户输入规整成完整地址：
 *   "192.168.1.5"        → "http://192.168.1.5:3000"
 *   "192.168.1.5:3000"   → "http://192.168.1.5:3000"
 *   "http://a.com"       → 原样
 */
function normalizeUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';

  const hasScheme = /^https?:\/\//i.test(url);
  if (!hasScheme) {
    // 没写协议时按"这是不是一个域名"来判断：
    //   纯 IP / 带端口 / localhost      → http（局域网开发环境）
    //   像域名的（含字母且无端口）      → https（穿透或线上环境）
    const isDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(url) && !/^\d+(\.\d+){3}/.test(url);
    const hasPort = /:\d+$/.test(url);
    url = `${isDomain && !hasPort ? 'https' : 'http'}://${url}`;
  }

  // 只有 host 没有端口时补默认端口：
  //   https 不补 443（显式写 :443 反而可能触发 SNI/代理问题）
  //   http 补 3000（本项目后端默认端口）
  const m = url.match(/^(https?):\/\/([^/:]+)(:\d+)?(\/.*)?$/i);
  if (m && !m[3]) {
    const scheme = m[1].toLowerCase();
    url = scheme === 'http'
      ? `http://${m[2]}:3000${m[4] || ''}`
      : `https://${m[2]}${m[4] || ''}`;
  }
  return url.replace(/\/+$/, '');
}

module.exports = {
  getBaseUrl,
  setBaseUrl,
  setLanBaseUrl,
  probeBaseUrls,
  normalizeUrl,
  getEnvInfo,
  isDevtools,
  DEV_URL,
  PROD_URL,
};

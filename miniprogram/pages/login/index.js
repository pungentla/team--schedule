const { request } = require('../../utils/request');
const {
  setBaseUrl,
  setLanBaseUrl,
  getBaseUrl,
  probeBaseUrls,
  normalizeUrl,
  getEnvInfo,
  isDevtools,
  DEV_URL,
} = require('../../config/env');

const ENV_LABELS = {
  develop: '开发版',
  trial: '体验版',
  release: '正式版',
};

Page({
  data: {
    employeeNo: '',
    password: '',
    loading: false,
    showServerPanel: false,
    serverUrl: '',
    envLabel: '开发版',
    isRealDevice: false,
    detecting: false,
    connError: '',
    logoPressTimer: null,
  },

  onLoad() {
    const { envVersion } = getEnvInfo();
    this.setData({
      serverUrl: getBaseUrl(),
      envLabel: ENV_LABELS[envVersion] || '开发版',
      isRealDevice: !isDevtools(),
    });
  },

  onShow() {
    // 用户可能从别的页面改了地址，回来同步一下
    this.setData({ serverUrl: getBaseUrl() });
  },

  onUnload() {
    if (this.data.logoPressTimer) clearTimeout(this.data.logoPressTimer);
  },

  onInputNo(e) {
    this.setData({ employeeNo: e.detail.value });
  },

  onInputPwd(e) {
    this.setData({ password: e.detail.value });
  },

  /** 长按 logo 3 秒仍保留（熟手快捷键） */
  onLogoTouchStart() {
    const timer = setTimeout(() => {
      this.openServerPanel();
    }, 3000);
    this.setData({ logoPressTimer: timer });
  },

  onLogoTouchEnd() {
    if (this.data.logoPressTimer) {
      clearTimeout(this.data.logoPressTimer);
      this.setData({ logoPressTimer: null });
    }
  },

  openServerPanel() {
    if (this.data.logoPressTimer) {
      clearTimeout(this.data.logoPressTimer);
      this.setData({ logoPressTimer: null });
    }
    this.setData({
      showServerPanel: true,
      serverUrl: getBaseUrl(),
      connError: '',
    });
  },

  closeServerPanel() {
    this.setData({ showServerPanel: false, connError: '' });
  },

  onInputServer(e) {
    this.setData({ serverUrl: e.detail.value, connError: '' });
  },

  useDevUrl() {
    this.setData({ serverUrl: DEV_URL, connError: '' });
  },

  /**
   * 自动探测：真机无法直接知道电脑 IP，但可以尝试常见网关网段。
   * 更可靠的做法是让用户看后端启动日志里打印的局域网地址后手填，
   * 这里只是尽力而为的便利功能。
   */
  async onAutoDetect() {
    if (this.data.detecting) return;
    this.setData({ detecting: true, connError: '' });

    // 常见家用/办公网段的 .1 ~ .30 与常见后端端口，量不宜过大
    const candidates = [];
    const prefixes = ['192.168.1', '192.168.0', '192.168.31', '10.0.0', '172.20.10'];
    for (const prefix of prefixes) {
      for (let i = 1; i <= 30; i++) {
        candidates.push(`http://${prefix}.${i}:3000`);
      }
    }

    try {
      const found = await probeBaseUrls(candidates);
      if (found) {
        this.setData({ serverUrl: found });
        wx.showToast({ title: '已找到后端服务', icon: 'success' });
      } else {
        this.setData({
          connError: '未自动找到后端。请查看电脑上后端启动日志里的「局域网访问」地址，手动填入。',
        });
      }
    } finally {
      this.setData({ detecting: false });
    }
  },

  /** 保存前先测一次连通性，避免"存了但连不上"的困惑 */
  async saveServer() {
    const url = normalizeUrl(this.data.serverUrl);
    if (!url) {
      this.setData({ connError: '请输入服务器地址' });
      return;
    }

    this.setData({ detecting: true, connError: '' });
    try {
      const ok = await probeBaseUrls([url]);
      if (!ok) {
        this.setData({
          connError: `连不上 ${url}/api/health。请确认：① 后端已启动 ② 手机与电脑同一 WiFi ③ 地址和端口正确 ④ 防火墙未拦截`,
        });
        return;
      }
      setBaseUrl(url);
      setLanBaseUrl(url);
      this.setData({ serverUrl: url, showServerPanel: false });
      wx.showToast({ title: '连接成功', icon: 'success' });
    } finally {
      this.setData({ detecting: false });
    }
  },

  async onLogin() {
    const { employeeNo, password, loading } = this.data;
    if (loading) return;
    if (!employeeNo.trim() || !password) {
      wx.showToast({ title: '请填写工号和密码', icon: 'none' });
      return;
    }
    this.setData({ loading: true });
    try {
      const res = await request('/api/auth/login', {
        method: 'POST',
        data: { employeeNo: employeeNo.trim(), password },
        silent: true,
      });
      const app = getApp();
      app.setSession(res.token, res.user);
      await app.refreshPendingCount();
      wx.reLaunch({ url: '/pages/home/index' });
    } catch (err) {
      // 网络失败时直接把用户引到服务器设置，而不是干看着 toast
      if (err.code === 'NETWORK') {
        this.setData({ showServerPanel: true, connError: err.message });
      } else {
        wx.showToast({ title: err.message, icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  goRegister() {
    wx.navigateTo({ url: '/pages/register/index' });
  },
});

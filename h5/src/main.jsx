import React, { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Alert from 'antd/es/alert';
import App from 'antd/es/app';
import Badge from 'antd/es/badge';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import ConfigProvider from 'antd/es/config-provider';
import Dropdown from 'antd/es/dropdown';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Spin from 'antd/es/spin';
import zhCN from 'antd/es/locale/zh_CN';
import BellOutlined from '@ant-design/icons/es/icons/BellOutlined';
import MessageOutlined from '@ant-design/icons/es/icons/MessageOutlined';
import 'dayjs/locale/zh-cn';
import 'antd/dist/reset.css';
import { API, Heading, Load, ProfileDisplayContext, accountRoles, assignmentLabel, dayjs, isAdmin, required, timeText, useAction, useLoad } from './shared';
import { Schedule, readScheduleFilters, saveScheduleFilters } from './Schedule';
import { Announcement } from './Announcement';
import { DiscussionPreview } from './DiscussionPreview';
import { ReminderSettings, logoutDevice, restoreDeviceReminder } from './ReminderSettings';
import { PullToRefresh, usePullRefresh } from './PullToRefresh';
import './style.css';

dayjs.locale('zh-cn');
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));
const Workflow = lazy(() => import('./Workflow').then(m => ({ default: m.Workflow })));
const Swaps = lazy(() => import('./Swaps').then(m => ({ default: m.Swaps })));
const Enrollment = lazy(() => import('./Enrollment').then(m => ({ default: m.Enrollment })));
const Discussions = lazy(() => import('./Discussions'));
const replyNotificationKey = 'new-discussion-reply';
const discussionNoticeLabels = {
  topic_comment: '你的话题有新评论',
  topic_reply: '你的话题有新回复',
  direct_reply: '有人回复了你',
  discussion_reply: '参与的话题有新回复',
};

const theme = {
  token: { colorPrimary: '#2e59ae', colorBgLayout: '#f2f5f9', colorText: '#1f2a3c', colorTextSecondary: '#58677e', borderRadius: 10, controlHeight: 42, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif' },
  components: { Card: { bodyPadding: 16, headerPadding: 16 }, Form: { itemMarginBottom: 14 } },
};

function Root() {
  const [user, setUser] = useState(() => API.getToken() ? API.getUser() : null);
  const { message } = App.useApp();
  function clearSession() { API.clearSession(); setUser(null); }
  useEffect(() => {
    let active = true;
    const token = API.getToken();
    const expired = () => { if (active) setUser(null); };
    window.addEventListener('teamshift:session-expired', expired);
    if (token) API.me().then(me => {
      if (active && API.getToken() === token) { API.setSession(token, me); setUser(me); }
    }).catch(e => { if (active && e.status !== 401) message.error(e.message); });
    return () => { active = false; window.removeEventListener('teamshift:session-expired', expired); };
  }, []);
  function updateProfile(profile) {
    const token = API.getToken();
    if (!token || API.getUser()?.id !== profile.id) return;
    API.setSession(token, profile);
    setUser(profile);
  }
  return user ? <ProfileDisplayContext.Provider value={JSON.stringify([user.name, user.nickname, user.nicknameEnabled])}>
    <Workspace key={user.id} user={user} updateProfile={updateProfile} endSession={clearSession} />
  </ProfileDisplayContext.Provider> : <Login loggedIn={({ token, user }) => { API.setSession(token, user); setUser(user); }} />;
}

function Login({ loggedIn }) {
  const { run, busy } = useAction();
  return <main className="login"><Card className="login-card">
    <h1>时禾</h1>
    <p className="muted">取意于《传道书》3:2 的「栽种有时」，寓意顺时耕耘，一起成长。</p>
    <Form layout="vertical" requiredMark={false} disabled={busy} onFinish={({ employeeNo, password }) => run(() => API.login(employeeNo.trim(), password), null, loggedIn)}>
      <Form.Item name="employeeNo" label="账号 / 工号" rules={required}><Input autoComplete="username" maxLength={32} placeholder="输入工号" /></Form.Item>
      <Form.Item name="password" label="密码" rules={required}><Input.Password autoComplete="current-password" maxLength={128} placeholder="输入密码" /></Form.Item>
      <Button block type="primary" htmlType="submit" loading={busy}>登录</Button>
    </Form>
  </Card></main>;
}

function readNotificationTarget() {
  const params = new URLSearchParams(window.location.search);
  const topic = Number(params.get('topic'));
  const reply = Number(params.get('reply'));
  const swap = Number(params.get('swap'));
  const notice = Number(params.get('notice'));
  const enrollment = Number(params.get('enrollment'));
  const systemNotice = Number(params.get('systemNotice'));
  const systemTarget = { systemNotice: Number.isSafeInteger(systemNotice) && systemNotice > 0 ? systemNotice : null };
  if (Number.isSafeInteger(enrollment) && enrollment > 0) return { ...systemTarget, tab: 'enrollment', enrollment };
  if (params.get('tab') === 'discussions') return { ...systemTarget, tab: 'discussions' };
  if (Number.isSafeInteger(topic) && topic > 0) return { tab: 'discussions', topic, reply: Number.isSafeInteger(reply) && reply > 0 ? reply : null };
  if (Number.isSafeInteger(swap) && swap > 0) return { tab: 'swaps', swap };
  return { tab: 'schedule', notice: Number.isSafeInteger(notice) && notice > 0 ? notice : null };
}

function Workspace(props) {
  const dirty = useRef(false);
  return <PullToRefresh canRefresh={() => !dirty.current}>
    <WorkspaceContent {...props} dirty={dirty} />
  </PullToRefresh>;
}

function WorkspaceContent({ user, updateProfile, endSession, dirty }) {
  const [notificationTarget, setNotificationTarget] = useState(readNotificationTarget);
  const [tab, setTab] = useState(notificationTarget.tab);
  const [settingsTab, setSettingsTab] = useState('worktypes');
  const [workflowPage, setWorkflowPage] = useState(null);
  const [discussionTopicId, setDiscussionTopicId] = useState(notificationTarget.topic ?? null);
  const [discussionReplyId, setDiscussionReplyId] = useState(notificationTarget.reply ?? null);
  const [discussionOpenVersion, setDiscussionOpenVersion] = useState(0);
  const [discussionFeedVersion, setDiscussionFeedVersion] = useState(0);
  const [enrollmentPeriodId, setEnrollmentPeriodId] = useState(notificationTarget.enrollment);
  const [swapDetail, setSwapDetail] = useState(notificationTarget.swap ?? null);
  const [password, setPassword] = useState(false);
  const [nicknameOpen, setNicknameOpen] = useState(false);
  const [reminders, setReminders] = useState(false);
  const [schedulePreferences, setSchedulePreferences] = useState(() => readScheduleFilters(user.id));
  const { scope: scheduleScope, byScope } = schedulePreferences;
  const scheduleFilters = byScope[scheduleScope];
  useEffect(() => saveScheduleFilters(user.id, schedulePreferences), [user.id, schedulePreferences]);
  useEffect(() => { restoreDeviceReminder(user.id).catch(() => {}); }, [user.id]);
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const key of ['reply', 'swap', 'notice', 'enrollment', 'tab', 'systemNotice']) url.searchParams.delete(key);
    if (tab === 'discussions' && discussionTopicId) url.searchParams.set('topic', discussionTopicId);
    else url.searchParams.delete('topic');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [tab, discussionTopicId]);
  const changeScheduleScope = scope => setSchedulePreferences(previous => ({ ...previous, scope }));
  const updateScheduleFilters = changes => setSchedulePreferences(({ scope, byScope }) => ({
    scope, byScope: { ...byScope, [scope]: { ...byScope[scope], ...changes } },
  }));
  const { confirm, busy, run } = useAction();
  const { message } = App.useApp();
  const periodsQuery = useLoad('periods', () => Promise.all([API.listPeriods(), API.currentPeriod()]), true);
  const unreadQuery = useLoad(user.id, API.unreadTopicReplies, true);
  const likeNotices = useLoad(user.id, API.unreadTopicLikes, true);
  const swapInbox = useLoad(user.id, API.swapInbox, true);
  const systemInbox = useLoad(user.id, API.unreadSystemNotices, true);
  const hotTopicsQuery = useLoad(tab === 'schedule' || tab === 'discussions' ? 'hot-topics' : null,
    () => API.discussionTopics(1, { sort: 'hot', pageSize: 3 }), true);
  usePullRefresh(periodsQuery.refreshPage, ['schedule', 'enrollment', 'workflow'].includes(tab));
  usePullRefresh(hotTopicsQuery.refreshPage, tab === 'schedule' || tab === 'discussions');
  usePullRefresh(swapInbox.refreshPage, tab === 'swaps');
  usePullRefresh(async () => {
    const results = await Promise.all([unreadQuery.refreshPage(), likeNotices.refreshPage()]);
    return results.every(Boolean);
  }, tab === 'discussions');
  const hotTopicRanks = new Map(hotTopicsQuery.data?.items
    .filter(topic => topic.likeCount + topic.replyCount > 0)
    .map((topic, index) => [topic.id, index + 1]));
  const refreshNotifications = useEffectEvent(() => { unreadQuery.refresh(); likeNotices.refresh(); swapInbox.refresh(); systemInbox.refresh(); });
  const readSystemNotice = useEffectEvent(id => API.markSystemNoticeRead(id).then(systemInbox.refresh, e => message.error(e.message)));
  useEffect(() => {
    if (notificationTarget.systemNotice) readSystemNotice(notificationTarget.systemNotice);
  }, [notificationTarget.systemNotice]);
  useEffect(() => {
    const refreshVisible = () => { if (!document.hidden) refreshNotifications(); };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    const timer = window.setInterval(refreshVisible, 30000);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(timer);
    };
  }, []);
  const unreadTopics = unreadQuery.data ?? [];
  const unreadCounts = new Map(unreadTopics.map(topic => [topic.id, topic.unreadCount]));
  const [periods, current] = periodsQuery.data || [[], null];
  const period = periods.find(p => p.id === scheduleFilters.periodId) || current || periods.find(p => p.status !== 'archived') || periods[0];
  const tabs = [
    ['schedule', '工作台'], ['discussions', '互动区'], ['enrollment', '我的报名'], ['swaps', '我的换班'],
    ...(isAdmin(user) ? [['workflow', '安排排班']] : []),
  ];
  const activeNav = tab === 'settings' ? 'workflow' : tab;
  async function navigate(next) {
    if (next === tab) return true;
    if (dirty.current && !await confirm('放弃未保存的需求？')) return false;
    dirty.current = false;
    setNotificationTarget({});
    if (next === 'workflow' && tab !== 'settings') setWorkflowPage(null);
    if (next !== 'swaps') setSwapDetail(null);
    setTab(next);
    window.scrollTo(0, 0);
    if (['workflow','enrollment'].includes(next)) periodsQuery.refresh();
    if (next === 'swaps') swapInbox.refresh();
    return true;
  }
  async function openSettings(section = settingsTab) {
    if (await navigate('settings')) setSettingsTab(section);
  }
  async function openDiscussions(topicId = null, replyId = null) {
    if (await navigate('discussions')) {
      setDiscussionTopicId(topicId);
      setDiscussionReplyId(replyId);
      if (topicId === discussionTopicId && topicId != null) setDiscussionOpenVersion(version => version + 1);
      unreadQuery.refresh();
    }
  }
  function backToTopics() {
    setDiscussionTopicId(null);
    setDiscussionReplyId(null);
  }
  async function openSwap(id) {
    if (await navigate('swaps')) setSwapDetail(id);
  }
  async function openSystemNotice(notice) {
    if (notice.kind === 'new_topics') {
      if (!await navigate('discussions')) return;
      backToTopics();
      setDiscussionFeedVersion(version => version + 1);
      window.scrollTo(0, 0);
    } else {
      if (!await navigate('enrollment')) return;
      setEnrollmentPeriodId(notice.periodId);
      periodsQuery.refresh();
      window.scrollTo(0, 0);
    }
    await API.markSystemNoticeRead(notice.id).then(systemInbox.refresh, e => message.error(e.message));
  }
  async function logout() {
    if (!await confirm('确认退出登录？', dirty.current ? '未保存的需求会丢失。' : '退出后需重新登录。')) return;
    await run(() => logoutDevice(user.id), null, endSession);
  }
  function sessionChanged() {
    endSession(); message.success('请使用更新后的账号重新登录');
  }
  const inTopic = tab === 'discussions' && discussionTopicId != null;
  return <div className="workspace">
    <div className="workspace-top">
      <header className="topbar"><div className="topbar-inner">
        <div className="brand-lockup"><span className="brand">时禾</span><span className="brand-caption">传3:2 栽种有时</span></div>
        <div className="account-actions">
          <BellNotifications query={unreadQuery} likeNotices={likeNotices} swapInbox={swapInbox} systemInbox={systemInbox}
            open={openDiscussions} openSwap={openSwap} openSystemNotice={openSystemNotice} />
          <Dropdown trigger={['click']} menu={{ items: [
            { key: 'nickname', label: '设置花名' }, { key: 'reminders', label: '消息提醒' }, { key: 'password', label: '修改密码' },
            { type: 'divider' }, { key: 'logout', label: '退出登录', danger: true, disabled: busy },
          ], onClick: ({ key }) => {
            if (key === 'nickname') setNicknameOpen(true);
            if (key === 'reminders') setReminders(true);
            if (key === 'password') setPassword(true);
            if (key === 'logout') void logout();
          } }}>
            <Button type="text" className="account-menu" title={`${user.name}（${user.employeeNo}）`}>{user.name}{isAdmin(user) && user.name !== accountRoles[user.role] && ` · ${accountRoles[user.role]}`} ▾</Button>
          </Dropdown>
        </div>
      </div></header>
      {inTopic ? <div className="topic-back-bar">
        <Button type="link" onClick={backToTopics}>← 返回话题列表</Button>
      </div> : (tab === 'schedule' || tab === 'discussions') && <div className="announcement-area">
        <Announcement key={tab} user={user} initialId={notificationTarget.notice} />
      </div>}
    </div>
    <main className="content stack">
      {tab === 'schedule' && <DiscussionPreview openDiscussions={openDiscussions} hotTopicsQuery={hotTopicsQuery} hotTopicRanks={hotTopicRanks} />}
      {isAdmin(user) && (tab === 'workflow' || tab === 'settings') && <Alert type="info" showIcon message="仅管理员可见" />}
      <Suspense fallback={<div className="loading"><Spin /></div>}>
        {tab === 'schedule' && <Schedule key={scheduleScope} user={user} periods={periods} period={period}
          scope={scheduleScope} changeScope={changeScheduleScope} filters={scheduleFilters} updateFilters={updateScheduleFilters} />}
        {tab === 'enrollment' && <Load query={periodsQuery}>{() => <Enrollment user={user} periods={periods} period={period}
          selected={enrollmentPeriodId} setSelected={setEnrollmentPeriodId} />}</Load>}
        {tab === 'swaps' && <Swaps user={user} detail={swapDetail} setDetail={setSwapDetail} inbox={swapInbox} />}
        {tab === 'discussions' && <Discussions key={discussionFeedVersion} topicId={discussionTopicId} replyId={discussionReplyId} openVersion={discussionOpenVersion} open={openDiscussions}
          unreadCounts={unreadCounts} refreshUnread={unreadQuery.refresh} refreshLikeNotices={likeNotices.refresh}
          hotTopicRanks={hotTopicRanks} refreshHotTopics={hotTopicsQuery.refresh}
          back={backToTopics} />}
        {tab === 'workflow' && isAdmin(user) && <Load query={periodsQuery}>{() => (
          <Workflow user={user} periods={periods} page={workflowPage} setPage={setWorkflowPage}
            refreshPeriods={periodsQuery.refresh} openSettings={openSettings} dirty={dirty} />
        )}</Load>}
        {tab === 'settings' && isAdmin(user) && <Settings user={user} tab={settingsTab} setTab={setSettingsTab}
          back={() => navigate('workflow')} onSessionChanged={sessionChanged} />}
      </Suspense>
    </main>
    <nav className="bottom-nav" aria-label="主导航"><div className="bottom-nav-inner">
      {tabs.map(([id, label]) => <Button key={id} type="text" aria-current={activeNav === id ? 'page' : undefined}
        className={id === 'discussions' ? 'discussion-nav-tab' : undefined}
        icon={id === 'discussions' ? <MessageOutlined aria-hidden="true" /> : undefined}
        onClick={() => id === 'discussions' ? openDiscussions() : navigate(id)}>{label}</Button>)}
    </div></nav>
    {nicknameOpen && <Nickname user={user} close={() => setNicknameOpen(false)} saved={profile => {
      updateProfile(profile);
      setNicknameOpen(false);
    }} />}
    {password && <Password close={() => setPassword(false)} saved={endSession} />}
    {reminders && <ReminderSettings close={() => setReminders(false)} />}
  </div>;
}

function BellNotifications({ query, likeNotices, swapInbox, systemInbox, open, openSwap, openSystemNotice }) {
  const { notification } = App.useApp();
  const seenThrough = useRef(null);
  const openTopic = useRef(open);
  useEffect(() => { openTopic.current = open; }, [open]);
  useEffect(() => () => notification.destroy(replyNotificationKey), [notification]);
  useEffect(() => {
    if (!query.data) return;
    const latest = query.data[0];
    const previous = seenThrough.current;
    seenThrough.current = Math.max(previous ?? 0, latest?.latestReplyId ?? 0);
    if (previous == null || !latest || latest.latestReplyId <= previous) return;
    notification.open({ key: replyNotificationKey, message: discussionNoticeLabels[latest.kind] ?? '收到话题回复', duration: 5, placement: 'bottomRight',
      description: <div className="reply-notification-copy">
        <strong>{latest.title}</strong><p>{latest.excerpt}</p>
        <Button type="link" onClick={() => { notification.destroy(replyNotificationKey); openTopic.current(latest.id, latest.latestReplyId); }}>查看回复</Button>
      </div>,
    });
  }, [query.data, notification]);
  const topics = query.data ?? [];
  const likes = likeNotices.data ?? [];
  const swaps = swapInbox.data ?? [];
  const system = systemInbox.data ?? [];
  const total = [...topics, ...likes].reduce((sum, topic) => sum + topic.unreadCount, swaps.length + system.length);
  const label = `消息提醒，${total} 条`;
  const button = <Button ghost className="reply-notification-button" aria-label={label} title={label}
    icon={<Badge count={total} size="small" overflowCount={999}><BellOutlined /></Badge>} />;
  const items = [];
  if (system.length) items.push({ type: 'group', key: 'system', label: '系统消息', children: system.map(notice => {
    const isTopic = notice.kind === 'new_topics';
    const isProxy = notice.kind === 'proxy_enrollment';
    const title = isTopic ? '互动区有新话题了' : isProxy ? `${notice.actorName || '管理员'}帮你代报名了` : `「${notice.periodName}」正在报名`;
    const action = isTopic ? '查看话题' : isProxy ? '查看报名' : '参与报名';
    return { key: `system:${notice.id}`, label: <div className="reply-notification-copy">
      <div className="reply-notification-item"><span>{title}</span></div>
      <p className="muted">{isProxy && `${notice.periodName} · `}{action}</p>
    </div> };
  }) });
  if (topics.length) items.push({ type: 'group', key: 'topics', label: '话题互动', children: topics.map(topic => ({
    key: `topic:${topic.id}`, label: <div className="reply-notification-copy">
      <div className="reply-notification-item"><span>{topic.title}</span><small className="muted">{topic.unreadCount} 条未读</small></div>
      <p className="muted">{discussionNoticeLabels[topic.kind] ?? '话题有新回复'}</p>
      <p className="muted">{topic.excerpt}</p>
    </div>,
  })) });
  if (likes.length) items.push({ type: 'group', key: 'likes', label: '话题点赞', children: likes.map(topic => ({
    key: `like:${topic.id}`, label: <div className="reply-notification-copy">
      <div className="reply-notification-item"><span>{topic.title}</span><small className="muted">{topic.unreadCount} 个新赞</small></div>
      <p className="muted">你的话题收到了点赞</p>
    </div>,
  })) });
  if (swaps.length) items.push({ type: 'group', key: 'swaps', label: '换班申请', children: swaps.map(swap => ({
    key: `swap:${swap.id}`, label: <div className="reply-notification-copy">
      <div className="reply-notification-item"><span>{swap.requesterName}发起的换班</span><small className="muted">待确认</small></div>
      {swap.fromAssign && <p className="muted">{assignmentLabel(swap.fromAssign)}</p>}
    </div>,
  })) });
  const inboxes = [query, likeNotices, swapInbox, systemInbox];
  if (inboxes.some(inbox => inbox.error)) items.push({ key: 'retry', label: '部分提醒加载失败，点击重试' });
  if (!items.length) items.push({ key: 'empty', label: inboxes.some(inbox => inbox.loading) ? '正在加载' : '暂无消息提醒', disabled: true });
  return <Dropdown trigger={['click']} onOpenChange={visible => { if (visible) notification.destroy(replyNotificationKey); }}
    menu={{ items, className: 'reply-notification-menu',
    onClick: ({ key }) => {
      if (key === 'retry') { inboxes.forEach(inbox => inbox.refresh()); return; }
      const [type, id] = key.split(':');
      if (type === 'system') {
        const notice = system.find(item => item.id === Number(id));
        if (notice) return openSystemNotice(notice);
        return;
      }
      if (type === 'swap') return openSwap(Number(id));
      if (type === 'like') return open(Number(id));
      const topic = topics.find(item => item.id === Number(id));
      if (topic) open(topic.id, topic.latestReplyId);
    } }}>{button}</Dropdown>;
}

function Nickname({ user, close, saved }) {
  const { run, busy, confirm } = useAction();
  const locked = Date.parse(user.nicknameNextChangeAt) > Date.now();

  async function enableNickname({ nickname }) {
    const nextNickname = nickname.trim().normalize('NFC');
    if (nextNickname !== user.nickname) {
      const title = user.nickname ? '确认修改花名？' : '确认设置花名？';
      if (!await confirm(title, `将启用花名「${nextNickname}」。确认后，30 天内无法再次改名。`)) return;
    }
    await run(() => API.saveNickname(nextNickname, true), '花名已启用', saved);
  }

  return <Modal open title="设置花名" onCancel={() => !busy && close()} footer={null}>
    <Form layout="vertical" initialValues={{ nickname: user.nickname || '' }} disabled={busy} onFinish={enableNickname}>
      <p className="muted">设置或修改花名后，需间隔 30 天才能再次改名。</p>
      <Form.Item className="nickname-field" name="nickname" label="花名" layout="horizontal" colon={false}
        labelCol={{ style: { flex: 'none', padding: 0 } }} wrapperCol={{ style: { flex: '1 1 0', minWidth: 0 } }}
        extra={locked && <span className="muted">下次可设置时间 {timeText(user.nicknameNextChangeAt)}</span>}
        rules={[{ required: true, whitespace: true, message: '请输入花名' }]}>
        <Input showCount maxLength={32} disabled={locked || busy} />
      </Form.Item>
      <div className="inline">
        <Button type="primary" htmlType="submit" disabled={busy || (locked && user.nicknameEnabled)} loading={busy}>启用花名</Button>
        {user.nicknameEnabled && <Button htmlType="button" onClick={() => run(() => API.setNicknameEnabled(false), '花名已禁用', saved)}>禁用花名</Button>}
      </div>
    </Form>
  </Modal>;
}

function Password({ close, saved }) {
  const { run, busy } = useAction();
  return <Modal open title="修改密码" onCancel={() => !busy && close()} footer={null}>
    <Form layout="vertical" disabled={busy} onFinish={({ oldPassword, newPassword }) => run(() => API.changePassword({ oldPassword, newPassword }), '密码已修改，请重新登录', saved)}>
      <Form.Item name="oldPassword" label="当前密码" rules={required}><Input.Password autoComplete="current-password" maxLength={128} /></Form.Item>
      <Form.Item name="newPassword" label="新密码" dependencies={['oldPassword']} rules={[
        { required: true, min: 6, max: 128, message: '新密码需为 6–128 位' },
        ({ getFieldValue }) => ({ validator: (_, v) => !v || v !== getFieldValue('oldPassword') ? Promise.resolve() : Promise.reject(new Error('新密码不能与原密码相同')) }),
      ]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[
        ...required, ({ getFieldValue }) => ({ validator: (_, v) => !v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次新密码不一致')) }),
      ]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>保存新密码</Button>
    </Form>
  </Modal>;
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}><App notification={{ bottom: 68 }}><Root /></App></ConfigProvider>
);

import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import Badge from 'antd/es/badge';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Checkbox from 'antd/es/checkbox';
import Form from 'antd/es/form';
import Image from 'antd/es/image';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Radio from 'antd/es/radio';
import Segmented from 'antd/es/segmented';
import Select from 'antd/es/select';
import Tabs from 'antd/es/tabs';
import Tag from 'antd/es/tag';
import Upload from 'antd/es/upload';
import ShareAltOutlined from '@ant-design/icons/es/icons/ShareAltOutlined';
import { TopicHeat } from './DiscussionPreview';
import { TopicShare } from './TopicShare';
import { API, Blank, Heading, Load, discussionName, option, timeText, useAction, useLoad } from './shared';

const categories = { chat: '闲聊', feedback: '吐槽', share: '文章分享', poll: '投票' };
const categoryTabs = [{ key: 'all', label: '全部' }, ...Object.entries(categories).map(([key, label]) => ({ key, label }))];
const topicOrders = [option('recent', '最新'), option('hot', '最热')];
const pollModeLabels = { single: '单选', multiple: '多选' };
const colors = { chat: 'blue', feedback: 'orange', share: 'green', poll: 'purple' };
const filled = message => ({ required: true, whitespace: true, message });
const maxImageBytes = 480 * 1024;
const acceptedImages = ['image/jpeg', 'image/png', 'image/webp'];

async function encodeTopicImage(file) {
  if (!acceptedImages.includes(file.type)) throw new Error('图片仅支持 JPG、PNG 或 WebP');
  if (file.size > 20 * 1024 * 1024) throw new Error('原图不能超过 20 MB');
  let image = file;
  if (image.size > maxImageBytes) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      for (const limit of [1600, 1200, 900, 675]) {
        const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        image = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (image && image.size <= maxImageBytes) break;
      }
    } finally {
      bitmap.close();
    }
    if (!image || image.size > maxImageBytes) throw new Error('图片过大，请换一张较小的图片');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择'));
    reader.readAsDataURL(image);
  });
}

export default function Discussions({ topicId, replyId, openVersion, back, open, unreadCounts, refreshUnread, refreshLikeNotices, hotTopicRanks, refreshHotTopics }) {
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('recent');
  const [anonymousOnly, setAnonymousOnly] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const [pageKey, setPageKey] = useState(null);
  const [feed, setFeed] = useState({ items: [], nextKey: null });
  const [expandedTopics, setExpandedTopics] = useState(() => new Set());
  const position = useRef(null);
  const page = sort === 'hot' ? pageKey ?? 1 : 1;
  const query = useLoad(`${category}:${sort}:${anonymousOnly}:${pageKey ?? ''}`, () => API.discussionTopics(page, {
    sort, ...(category === 'all' ? {} : { category }), ...(anonymousOnly ? { anonymous: true } : {}),
    ...(sort === 'recent' && pageKey ? { before: pageKey } : {}),
  }));
  useLayoutEffect(() => {
    if (!query.data) return;
    const { items, nextCursor, pageSize, total } = query.data;
    const nextKey = sort === 'hot' ? (page * pageSize < total ? page + 1 : null) : nextCursor;
    setFeed(current => {
      if (pageKey == null) return { items, nextKey };
      const loaded = new Set(current.items.map(topic => topic.id));
      return { items: [...current.items, ...items.filter(topic => !loaded.has(topic.id))], nextKey };
    });
  }, [page, pageKey, query.data, sort]);

  const updateTopic = useCallback((id, changes) => {
    setFeed(current => ({ ...current, items: current.items.map(topic => topic.id === id ? { ...topic, ...changes } : topic) }));
  }, []);
  function removeTopic(id) {
    setFeed(current => ({ ...current, items: current.items.filter(topic => topic.id !== id) }));
    setExpandedTopics(current => new Set([...current].filter(topicId => topicId !== id)));
    refreshUnread();
    refreshLikeNotices();
    refreshHotTopics();
  }
  function toggleDiscussion(id) {
    setExpandedTopics(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function reload(nextCategory = category, nextSort = sort, nextAnonymousOnly = anonymousOnly) {
    position.current = null;
    setFeed({ items: [], nextKey: null });
    setExpandedTopics(new Set());
    setCategory(nextCategory);
    setSort(nextSort);
    setAnonymousOnly(nextAnonymousOnly);
    setPageKey(null);
    query.refresh();
    refreshHotTopics();
    window.scrollTo(0, 0);
  }
  const { nextKey } = feed;
  const loadMore = useCallback(() => {
    if (nextKey && !query.loading && !query.error) setPageKey(nextKey);
  }, [nextKey, query.loading, query.error]);

  return topicId ? <TopicDetail key={`${topicId}:${openVersion}`} topicId={topicId} replyId={replyId} now={now} back={back} updateTopic={updateTopic}
    refreshUnread={refreshUnread} refreshLikeNotices={refreshLikeNotices} heatRank={hotTopicRanks.get(topicId)} refreshHotTopics={refreshHotTopics}
    deleted={() => { removeTopic(topicId); back(); }} />
    : <TopicList items={feed.items} hasMore={!!nextKey} query={query} loadMore={loadMore} reload={reload}
      updateTopic={updateTopic} removeTopic={removeTopic} position={position} open={open}
      category={category} sort={sort} anonymousOnly={anonymousOnly} unreadCounts={unreadCounts} refreshUnread={refreshUnread}
      hotTopicRanks={hotTopicRanks} refreshHotTopics={refreshHotTopics} now={now}
      expandedTopics={expandedTopics} toggleDiscussion={toggleDiscussion} />;
}

function TopicDetail({ topicId, replyId, now, back, updateTopic, deleted, refreshUnread, refreshLikeNotices, heatRank, refreshHotTopics }) {
  const [expanded, setExpanded] = useState(true);
  const query = useLoad(topicId, () => API.discussionTopic(topicId), true);
  const refreshLikes = useEffectEvent(refreshLikeNotices);
  const unreadLikeThrough = query.data?.unreadLikeThrough;
  useEffect(() => {
    if (unreadLikeThrough) API.markTopicLikesRead(topicId, unreadLikeThrough).then(() => refreshLikes()).catch(() => {});
  }, [topicId, unreadLikeThrough]);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, []);
  useEffect(() => {
    if (query.data && !query.loading) {
      const { poll, unreadLikeThrough: _unreadLikeThrough, ...summary } = query.data;
      updateTopic(topicId, poll ? { ...summary, pollOptions: poll.options.map(({ voters, ...option }) => option) } : summary);
    }
  }, [topicId, query.data, query.loading, updateTopic]);
  return <>
    <Card size="small"><Button type="link" onClick={back}>← 返回话题列表</Button></Card>
    <Load query={query}>{topic => <TopicCard topic={topic} replyId={replyId} now={now} updated={query.refresh} deleted={deleted} loading={query.loading} refreshUnread={refreshUnread}
      heatRank={heatRank} refreshHotTopics={refreshHotTopics}
      expanded={expanded} toggleDiscussion={() => setExpanded(value => !value)} />}</Load>
  </>;
}

function TopicList({ items, hasMore, query, loadMore, reload, updateTopic, removeTopic, position, open, category, sort, anonymousOnly,
  expandedTopics, toggleDiscussion, unreadCounts, refreshUnread, hotTopicRanks, refreshHotTopics, now }) {
  const [creating, setCreating] = useState(false);
  const [scrollMargin, setScrollMargin] = useState(position.current?.margin ?? 0);
  const [stickyTop, setStickyTop] = useState(0);
  const list = useRef(null);
  const bottom = useRef(null);
  const getItemKey = useCallback(index => items[index].id, [items]);
  const virtualizer = useWindowVirtualizer({
    count: items.length, getItemKey, estimateSize: index => {
      const topic = items[index];
      const cardHeight = topic.imageCount ? 255 : 155;
      return topic.pollOptions?.length ? cardHeight + 48 + 24 * topic.pollOptions.length : cardHeight;
    },
    gap: 12, overscan: 3, scrollMargin,
    initialOffset: position.current?.offset ?? 0,
    initialMeasurementsCache: position.current?.measurements,
  });

  useLayoutEffect(() => {
    const workspaceTop = list.current.closest('.workspace').querySelector('.workspace-top');
    const measure = () => {
      setStickyTop(workspaceTop.getBoundingClientRect().height);
      setScrollMargin(list.current.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list.current.closest('main'));
    observer.observe(workspaceTop);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!hasMore || query.loading || query.error || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore();
    }, { rootMargin: '0px 0px 480px' });
    observer.observe(bottom.current);
    return () => observer.disconnect();
  }, [hasMore, query.loading, query.error, loadMore]);

  function openTopic(id) {
    position.current = { offset: window.scrollY, margin: scrollMargin, measurements: virtualizer.takeSnapshot() };
    open(id);
  }
  return <>
    <Card className="topic-list-controls" style={{ top: stickyTop }}>
      <div className="row-between">
        <div className="inline topic-list-heading">
          <Heading>互动区</Heading>
          <Segmented size="small" options={topicOrders} value={sort} onChange={order => reload(category, order)} aria-label="话题排序" />
        </div>
        <Button type="primary" onClick={() => setCreating(true)}>发起话题</Button>
      </div>
      <Tabs className="topic-category-tabs" size="small" activeKey={category} onChange={reload} items={categoryTabs}
        tabBarExtraContent={{ right: <Checkbox className="topic-anonymous-filter" checked={anonymousOnly} aria-label="仅看匿名话题"
          onChange={event => reload(category, sort, event.target.checked)}>匿名</Checkbox> }} />
    </Card>
    <div ref={list} className="topic-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => {
        const topic = items[row.index];
        return <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="topic-virtual-row"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}>
          <TopicCard topic={topic} now={now} open={() => openTopic(topic.id)} updated={changes => updateTopic(topic.id, changes)}
            unreadCount={unreadCounts.get(topic.id)} refreshUnread={refreshUnread}
            heatRank={hotTopicRanks.get(topic.id)} refreshHotTopics={refreshHotTopics}
            deleted={() => removeTopic(topic.id)} expanded={expandedTopics.has(topic.id)} toggleDiscussion={() => toggleDiscussion(topic.id)} />
        </div>;
      })}
    </div>
    {!items.length && !hasMore && !query.loading && !query.error && <Card><Blank>{anonymousOnly ? '没有符合条件的匿名话题' : '还没有话题'}</Blank></Card>}
    <div ref={bottom} className="topic-feed-end">
      {query.error ? <div className="inline"><span className="muted">话题加载失败</span><Button onClick={query.refresh}>重试</Button></div>
        : (hasMore || query.loading) && <Button loading={query.loading} onClick={loadMore}>加载更多</Button>}
    </div>
    {creating && <NewTopic close={() => setCreating(false)} saved={topic => {
      setCreating(false);
      reload(category === 'all' ? 'all' : topic.category, 'recent', anonymousOnly && topic.anonymous);
    }} />}
  </>;
}

function NewTopic({ close, saved }) {
  const [form] = Form.useForm();
  const [files, setFiles] = useState([]);
  const category = Form.useWatch('category', form);
  const { run, busy } = useAction();
  return <Modal open title="发起话题" onCancel={() => !busy && close()} footer={null}>
    <Form form={form} layout="vertical" initialValues={{ category: 'chat', anonymous: false, pollMode: 'single', pollOptions: ['', ''] }} disabled={busy}
      onFinish={values => run(async () => {
        const images = await Promise.all(files.map(file => encodeTopicImage(file.originFileObj || file)));
        const pollClosesAt = values.pollClosesAt ? new Date(values.pollClosesAt).toISOString() : undefined;
        return API.createTopic({ ...values, images, pollClosesAt });
      }, '话题已发布', saved)}>
      <Form.Item name="category" label="分类"><Select options={Object.entries(categories).map(([key, label]) => option(key, label))} /></Form.Item>
      <Form.Item name="title" label="话题标题" rules={[filled('请输入话题标题')]}><Input maxLength={80} /></Form.Item>
      <Form.Item name="anonymous" valuePropName="checked"><Checkbox>匿名发布（话题内使用随机昵称）</Checkbox></Form.Item>
      {category === 'poll' && <Form.Item name="pollMode" label="投票方式">
        <Radio.Group options={Object.entries(pollModeLabels).map(([mode, label]) => option(mode, label))} />
      </Form.Item>}
      {category === 'poll' && <Form.Item name="pollClosesAt" label="投票截止时间（选填）" preserve={false}
        rules={[{ validator: (_, value) => !value || Date.parse(value) > Date.now()
          ? Promise.resolve() : Promise.reject(new Error('截止时间必须晚于当前时间')) }]}>
        <Input type="datetime-local" />
      </Form.Item>}
      {category === 'poll' && <Form.List name="pollOptions">{(fields, { add, remove }) => <div className="form-section">
        {fields.map((field, index) => <div className="poll-option-row" key={field.key}>
          <Form.Item name={field.name} label={`选项 ${index + 1}`} rules={[filled('请输入选项')]}>
            <Input maxLength={80} />
          </Form.Item>
          {fields.length > 2 && <Button onClick={() => remove(field.name)} aria-label={`删除选项 ${index + 1}`}>删除</Button>}
        </div>)}
        {fields.length < 6 && <Button onClick={() => add('')}>添加选项</Button>}
      </div>}</Form.List>}
      {category === 'share' && <Form.Item name="articleUrl" label="文章链接（可选）" preserve={false}>
        <Input inputMode="url" placeholder="https://" maxLength={2048} />
      </Form.Item>}
      <Form.Item name="content" label="正文" dependencies={['articleUrl']} rules={[({ getFieldValue }) => ({
        validator: (_, value) => category === 'poll' || value?.trim() || files.length || (category === 'share' && getFieldValue('articleUrl')?.trim())
          ? Promise.resolve() : Promise.reject(new Error(category === 'share' ? '请填写正文、文章链接或添加图片' : '请填写正文或添加图片')),
      })]}>
        <Input.TextArea rows={4} maxLength={3000} showCount />
      </Form.Item>
      <Form.Item label="图片">
        <Upload accept={acceptedImages.join(',')} multiple listType="picture" maxCount={3} beforeUpload={() => false}
          fileList={files} onChange={({ fileList }) => setFiles(fileList)} disabled={busy}>
          {files.length < 3 && <Button>添加图片</Button>}
        </Upload>
        <div className="muted">最多 3 张，支持 JPG、PNG 和 WebP</div>
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>发布话题</Button>
    </Form>
  </Modal>;
}

function TopicCard({ topic, replyId, now, open, updated, deleted, loading, expanded, toggleDiscussion, unreadCount, refreshUnread, heatRank, refreshHotTopics }) {
  const { run, busy, confirm } = useAction();
  const [sharing, setSharing] = useState(false);
  const liked = !!topic.liked;
  const pollClosed = !!topic.pollClosesAt && Date.parse(topic.pollClosesAt) <= now;
  function updateEngagement(changes) {
    updated(changes);
    refreshHotTopics();
  }
  async function deleteTopic() {
    if (await confirm('删除这个话题？', '话题下的回复、图片和点赞会一并删除。', true)) {
      await run(() => API.deleteTopic(topic.id), '话题已删除', deleted);
    }
  }
  function openCard(event) {
    if (!event.target.closest('button, a')) open();
  }
  return <><Card className={open ? 'topic-card topic-card-clickable' : 'topic-card'} onClick={open ? openCard : undefined}>
    <div className="inline topic-card-heading">
      <h3>{open ? <button type="button" className="topic-title-button" onClick={open}>{topic.title}</button> : topic.title}</h3>
      <Tag color={colors[topic.category]}>{categories[topic.category]}</Tag>
      {!!topic.anonymous && <Tag>匿名</Tag>}
      <Badge size="small" count={unreadCount} title={unreadCount ? `${unreadCount} 条未读回复` : undefined} />
      <TopicHeat rank={heatRank} />
    </div>
    <div className="muted">{discussionName(topic)} · {timeText(topic.createdAt)}</div>
    {topic.content && <p className={`discussion-text${open ? ' topic-preview' : ''}`}>{topic.content}</p>}
    {topic.articleUrl && <a className="article-link" href={topic.articleUrl} target="_blank" rel="noopener noreferrer">打开文章 ↗</a>}
    {topic.imageCount > 0 && <TopicImages topicId={topic.id} count={topic.imageCount} compact={!!open} />}
    {topic.poll && <TopicPoll topicId={topic.id} poll={topic.poll} anonymous={topic.anonymous}
      closesAt={topic.pollClosesAt} closed={pollClosed} loading={loading} updated={updated} />}
    {!topic.poll && topic.pollOptions?.length > 0 && <section className="topic-poll" aria-label="投票内容">
      <PollHeading mode={topic.pollMode} closesAt={topic.pollClosesAt} closed={pollClosed}
        hasVoted={topic.pollOptions.some(item => item.votes != null)} />
      <ul className="poll-preview-options">
        {topic.pollOptions.map(item => <li className="row-between" key={item.position}>
          <span className="poll-option-label">{item.label}</span>
          {item.votes != null && <small className="muted">{item.votes} 票</small>}
        </li>)}
      </ul>
    </section>}
    <div className="topic-actions inline">
      <Button type="text" danger={liked} aria-pressed={liked} loading={busy} disabled={loading}
        title={liked ? '取消点赞' : '点赞'} onClick={() => run(() => API.setTopicLike(topic.id, !liked), null, updateEngagement)}>
        {liked ? '♥ 已点赞' : '♡ 点赞'} {topic.likeCount ?? 0}
      </Button>
      <Button type="link" icon={<ShareAltOutlined aria-hidden="true" />} onClick={() => setSharing(true)}>分享</Button>
      {!!topic.canDelete && <Button type="text" className="topic-delete" disabled={busy || loading} onClick={deleteTopic}>删除话题</Button>}
      <Button type="link" className="topic-discussion" aria-expanded={expanded} aria-controls={`topic-replies-${topic.id}`} onClick={toggleDiscussion}>
        {expanded ? '收起讨论' : `查看讨论（${topic.replyCount}）`}
      </Button>
    </div>
    <div id={`topic-replies-${topic.id}`} hidden={!expanded} onClick={event => event.stopPropagation()}>
      {expanded && <TopicReplies topicId={topic.id} replyId={replyId} replyCount={topic.replyCount} anonymous={topic.anonymous}
        updated={updateEngagement} close={toggleDiscussion} refreshUnread={refreshUnread} />}
    </div>
  </Card>
    {sharing && <TopicShare topic={topic} category={categories[topic.category]} close={() => setSharing(false)} />}
  </>;
}

function PollHeading({ mode, closesAt, closed, hasVoted }) {
  return <div className="inline">
    <strong>{pollModeLabels[mode]}</strong>
    <Tag color={closed ? undefined : hasVoted ? 'green' : 'blue'}>{closed ? '已截止' : hasVoted ? '已投票' : '待投票'}</Tag>
    {closesAt && <span className="muted">截止 {timeText(closesAt)}</span>}
  </div>;
}

function TopicPoll({ topicId, poll, anonymous, closesAt, closed, loading, updated }) {
  const [choice, setChoice] = useState([]);
  const { run, busy, confirm } = useAction();
  const multiple = poll.mode === 'multiple';
  const hasVoted = poll.votedPositions.length > 0;
  const VoteGroup = multiple ? Checkbox.Group : Radio.Group;
  const VoteOption = multiple ? Checkbox : Radio;
  const selected = hasVoted ? poll.votedPositions : choice;
  const total = hasVoted ? poll.options.reduce((sum, item) => sum + item.votes, 0) : null;
  async function submitVote() {
    const chosen = poll.options.filter(item => selected.includes(item.position));
    const content = <div><ul>{chosen.map(item => <li key={item.position}>{item.label}</li>)}</ul><p>提交后不能更改选票。</p></div>;
    if (await confirm('确认提交选票？', content)) await run(() => API.voteTopic(topicId, selected), '已记录投票', updated);
  }
  return <section className="topic-poll stack" aria-label="话题投票">
    <PollHeading mode={poll.mode} closesAt={closesAt} closed={closed} hasVoted={hasVoted} />
    <VoteGroup className="stack" value={multiple ? selected : selected[0]} disabled={closed || hasVoted || busy || loading}
      onChange={multiple ? setChoice : event => setChoice([event.target.value])}>
      {poll.options.map(item => <div key={item.position}>
        <div className="row-between">
          <VoteOption value={item.position}>{item.label}</VoteOption>
          {hasVoted && <span className="muted">{item.votes} 票</span>}
        </div>
        {item.voters?.length > 0 && <p className="muted poll-voter-names">{item.voters.join('、')}</p>}
      </div>)}
    </VoteGroup>
    <div className="inline">
      <Button type="primary" loading={busy} disabled={closed || hasVoted || loading || !selected.length} onClick={submitVote}>
        {hasVoted ? '已投票' : closed ? '投票已截止' : '投票'}
      </Button>
      <span className="muted">{hasVoted
        ? `${multiple ? `${poll.voterCount} 人参与 · ` : ''}共 ${total} 票`
        : closed ? '仅已投票成员可查看结果' : '提交后可查看结果，选票不可更改'}</span>
    </div>
    {!anonymous && !hasVoted && !closed && <p className="muted">投票后，参与者可查看各选项的投票人。</p>}
  </section>;
}

function TopicImages({ topicId, count, compact }) {
  const container = useRef(null);
  const [nearViewport, setNearViewport] = useState(!compact);
  const [activeImage, setActiveImage] = useState(null);
  const query = useLoad(nearViewport ? topicId : null, () => API.topicImages(topicId));
  const gridClass = compact ? 'topic-images topic-images-compact' : 'topic-images';

  useEffect(() => {
    if (nearViewport) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setNearViewport(true);
    }, { rootMargin: '160px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [nearViewport]);

  return <div ref={container} onClick={event => event.stopPropagation()}>
    {!nearViewport || query.loading ? <div className={gridClass} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <span className="topic-image-placeholder" key={index} />)}
    </div> : <Load query={query}>{images => <div className={gridClass}>
      <Image.PreviewGroup items={images.map(image => ({ src: image.src, alt: `话题图片 ${image.position}` }))}
        preview={{ visible: activeImage !== null, current: activeImage ?? 0, onChange: setActiveImage,
          onVisibleChange: visible => { if (!visible) setActiveImage(null); } }}>
        {images.map((image, index) => <button className="topic-image-thumbnail" type="button" key={image.position}
          aria-label={`查看话题图片 ${image.position}`} onClick={() => setActiveImage(index)}>
          <img src={image.src} alt="" decoding="async" />
        </button>)}
      </Image.PreviewGroup>
    </div>}</Load>}
  </div>;
}

function TopicReplies({ topicId, replyId, replyCount, anonymous, updated, close, refreshUnread }) {
  const [page, setPage] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const replyInput = useRef(null);
  const section = useRef(null);
  const focused = useRef(false);
  const scrollPage = useRef(false);
  const [form] = Form.useForm();
  const query = useLoad(page ?? 'initial', () => API.topicReplies(topicId, page, replyId), true);
  const { run, busy } = useAction();
  const { run: remove, busy: removing, confirm } = useAction();
  const syncReplyCount = useEffectEvent(total => {
    if (total !== replyCount) updated({ replyCount: total });
  });
  const total = query.data?.total;
  useEffect(() => {
    if (total != null) syncReplyCount(total);
  }, [total]);
  const clearUnread = useEffectEvent(ids => {
    return API.markTopicRepliesRead(topicId, ids).then(refreshUnread);
  });
  useLayoutEffect(() => {
    if (!query.data || query.loading) return;
    const reply = replyId != null && page == null && !focused.current
      ? section.current.querySelector(`[data-reply-id="${replyId}"]`) : null;
    const target = reply || (scrollPage.current ? section.current : null);
    if (!target) return;
    if (reply) focused.current = true;
    scrollPage.current = false;
    const workspace = section.current.closest('.workspace');
    const header = workspace.querySelector('.workspace-top');
    const controls = workspace.querySelector('.topic-list-controls');
    const top = header.getBoundingClientRect().height + (controls?.getBoundingClientRect().height ?? 0);
    window.scrollTo(0, window.scrollY + target.getBoundingClientRect().top - top - 12);
  }, [query.data, query.loading, page, replyId]);
  useEffect(() => {
    if (!query.data || query.loading) return;
    const unread = [...section.current.querySelectorAll('[data-unread-reply]')];
    if (!unread.length) return;
    const workspace = section.current.closest('.workspace');
    const header = workspace.querySelector('.workspace-top');
    const listControls = workspace.querySelector('.topic-list-controls');
    const footer = workspace.querySelector('.bottom-nav');
    const marked = new Set();
    let observer;
    const observe = () => {
      observer?.disconnect();
      if (document.hidden) return;
      const top = Math.ceil(header.getBoundingClientRect().height + (listControls?.getBoundingClientRect().height ?? 0));
      const bottom = Math.ceil(footer.getBoundingClientRect().height);
      observer = new IntersectionObserver(entries => {
        const ids = entries.filter(entry => entry.intersectionRatio >= 0.5)
          .map(entry => Number(entry.target.dataset.unreadReply)).filter(id => !marked.has(id));
        if (!ids.length || document.hidden) return;
        ids.forEach(id => marked.add(id));
        clearUnread(ids).catch(() => ids.forEach(id => marked.delete(id)));
      }, { threshold: 0.5, rootMargin: `-${top}px 0px -${bottom}px 0px` });
      unread.forEach(element => observer.observe(element));
    };
    const resize = new ResizeObserver(observe);
    [header, listControls, footer].filter(Boolean).forEach(element => resize.observe(element));
    document.addEventListener('visibilitychange', observe);
    observe();
    return () => {
      observer?.disconnect();
      resize.disconnect();
      document.removeEventListener('visibilitychange', observe);
    };
  }, [query.data, query.loading]);
  async function deleteReply(id) {
    if (await confirm('删除这条回复？', null, true)) {
      await remove(() => API.deleteTopicReply(topicId, id), '回复已删除', ({ total }) => {
        setReplyTo(current => current?.id === id ? null : current);
        setPage(Math.min(query.data.page, Math.max(1, Math.ceil(total / query.data.pageSize))));
        query.refresh();
        refreshUnread();
      });
    }
  }
  return <section ref={section} className="topic-replies stack" aria-label="话题讨论">
    <Load query={query}>{data => <>
      {data.items.length ? data.items.map(reply => <article className={`topic-reply${page == null && reply.id === replyId ? ' topic-reply-highlight' : ''}`}
        key={reply.id} data-reply-id={reply.id}>
        <div className="row-between" data-unread-reply={reply.unread ? reply.id : undefined}>
          <div className="inline topic-reply-meta">
            <strong>{discussionName(reply, anonymous)}</strong>
            <time className="muted" dateTime={reply.createdAt}>{timeText(reply.createdAt)}</time>
          </div>
          <div className="inline topic-reply-actions">
            <Button type="link" size="small" disabled={busy || removing || query.loading} onClick={() => {
              setReplyTo(reply);
              replyInput.current?.focus();
            }}>回复</Button>
            {!!reply.canDelete && <Button type="text" danger size="small" disabled={busy || removing || query.loading} onClick={() => deleteReply(reply.id)}>删除回复</Button>}
          </div>
        </div>
        {reply.replyToId && <div className="topic-reply-reference muted">
          <strong>回复 {anonymous ? reply.replyToAnonymousName || '匿名成员' : reply.replyToName || '成员'}</strong>
          <p className="topic-preview">{reply.replyToExcerpt}</p>
        </div>}
        <p className="discussion-text">{reply.content}</p>
      </article>) : <span className="muted">暂无回复</span>}
      <TopicPagination data={data} page={data.page} changePage={next => { scrollPage.current = true; setPage(next); }} />
    </>}</Load>
    <Form form={form} className="topic-reply-form" layout="vertical" disabled={busy || removing} onFinish={({ content }) => run(
      () => API.replyToTopic(topicId, content, replyTo?.id), replyTo ? '回复已发布' : '评论已发布', reply => {
        form.resetFields();
        setReplyTo(null);
        setPage(reply.page);
        query.refresh();
      }
    )}>
      {replyTo && <div className="topic-reply-reference muted">
        <strong>回复 {discussionName(replyTo, anonymous)}</strong>
        <p className="topic-preview">{replyTo.content}</p>
      </div>}
      <Form.Item name="content" label={replyTo ? '回复' : '评论'} rules={[filled(replyTo ? '请输入回复内容' : '请输入评论内容')]}>
        <Input.TextArea ref={replyInput} rows={2} maxLength={2000} />
      </Form.Item>
      <div className="inline">
        <Button type="primary" htmlType="submit" loading={busy}>{replyTo ? '发布回复' : '发表评论'}</Button>
        {replyTo ? <Button type="link" onClick={() => setReplyTo(null)}>取消回复</Button>
          : <Button type="link" onClick={close}>取消</Button>}
      </div>
    </Form>
  </section>;
}

function TopicPagination({ data, page, changePage }) {
  return <Pagination simple size="small" hideOnSinglePage current={page} total={data.total}
    pageSize={data.pageSize} onChange={changePage} />;
}

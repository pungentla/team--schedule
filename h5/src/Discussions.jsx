import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import Button from 'antd/es/button';
import Card from 'antd/es/card';
import Form from 'antd/es/form';
import Image from 'antd/es/image';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import Pagination from 'antd/es/pagination';
import Select from 'antd/es/select';
import Tag from 'antd/es/tag';
import Upload from 'antd/es/upload';
import { API, Blank, Heading, Load, option, timeText, useAction, useLoad } from './shared';

const categories = { chat: '闲聊', feedback: '吐槽', share: '文章分享' };
const colors = { chat: 'blue', feedback: 'orange', share: 'green' };
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

export default function Discussions({ topicId, back, open }) {
  const [cursor, setCursor] = useState(0);
  const [feed, setFeed] = useState({ items: [], nextCursor: null });
  const [expandedTopics, setExpandedTopics] = useState(() => new Set());
  const position = useRef(null);
  const query = useLoad(cursor, () => API.discussionTopics(1, cursor ? { before: cursor } : undefined));
  useLayoutEffect(() => {
    if (!query.data) return;
    const { items, nextCursor } = query.data;
    setFeed(current => ({ items: cursor ? [...current.items, ...items] : items, nextCursor }));
  }, [cursor, query.data]);

  const updateTopic = useCallback((id, changes) => {
    setFeed(current => ({ ...current, items: current.items.map(topic => topic.id === id ? { ...topic, ...changes } : topic) }));
  }, []);
  function removeTopic(id) {
    setFeed(current => ({ ...current, items: current.items.filter(topic => topic.id !== id) }));
    setExpandedTopics(current => new Set([...current].filter(topicId => topicId !== id)));
  }
  function toggleDiscussion(id) {
    setExpandedTopics(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function reload() {
    position.current = null;
    setFeed({ items: [], nextCursor: null });
    setCursor(0);
    query.refresh();
    window.scrollTo(0, 0);
  }
  const nextCursor = feed.nextCursor;
  const loadMore = useCallback(() => {
    if (nextCursor && !query.loading && !query.error) setCursor(nextCursor);
  }, [nextCursor, query.loading, query.error]);

  return topicId ? <TopicDetail key={topicId} topicId={topicId} back={back} updateTopic={updateTopic}
    deleted={() => { removeTopic(topicId); back(); }} />
    : <TopicList items={feed.items} hasMore={!!nextCursor} query={query} loadMore={loadMore} reload={reload}
      updateTopic={updateTopic} removeTopic={removeTopic} position={position} open={open}
      expandedTopics={expandedTopics} toggleDiscussion={toggleDiscussion} />;
}

function TopicDetail({ topicId, back, updateTopic, deleted }) {
  const [expanded, setExpanded] = useState(true);
  const query = useLoad(topicId, () => API.discussionTopic(topicId), true);
  useLayoutEffect(() => { window.scrollTo(0, 0); }, []);
  useEffect(() => {
    if (query.data && !query.loading) updateTopic(topicId, query.data);
  }, [topicId, query.data, query.loading, updateTopic]);
  return <>
    <Card size="small"><Button type="link" onClick={back}>← 返回话题列表</Button></Card>
    <Load query={query}>{topic => <TopicCard topic={topic} updated={query.refresh} deleted={deleted} loading={query.loading}
      expanded={expanded} toggleDiscussion={() => setExpanded(value => !value)} />}</Load>
  </>;
}

function TopicList({ items, hasMore, query, loadMore, reload, updateTopic, removeTopic, position, open, expandedTopics, toggleDiscussion }) {
  const [creating, setCreating] = useState(false);
  const [scrollMargin, setScrollMargin] = useState(position.current?.margin ?? 0);
  const list = useRef(null);
  const bottom = useRef(null);
  const getItemKey = useCallback(index => items[index].id, [items]);
  const virtualizer = useWindowVirtualizer({
    count: items.length, getItemKey, estimateSize: index => items[index].imageCount ? 255 : 155,
    gap: 12, overscan: 3, scrollMargin,
    initialOffset: position.current?.offset ?? 0,
    initialMeasurementsCache: position.current?.measurements,
  });

  useLayoutEffect(() => {
    const updateMargin = () => setScrollMargin(list.current.getBoundingClientRect().top + window.scrollY);
    updateMargin();
    const observer = new ResizeObserver(updateMargin);
    observer.observe(list.current.closest('main'));
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
    <Card><div className="row-between">
      <Heading>互动区</Heading>
      <Button type="primary" onClick={() => setCreating(true)}>发起话题</Button>
    </div></Card>
    <div ref={list} className="topic-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => {
        const topic = items[row.index];
        return <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} className="topic-virtual-row"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}>
          <TopicCard topic={topic} open={() => openTopic(topic.id)} updated={changes => updateTopic(topic.id, changes)}
            deleted={() => removeTopic(topic.id)} expanded={expandedTopics.has(topic.id)} toggleDiscussion={() => toggleDiscussion(topic.id)} />
        </div>;
      })}
    </div>
    {!items.length && !hasMore && !query.loading && !query.error && <Card><Blank>还没有话题</Blank></Card>}
    <div ref={bottom} className="topic-feed-end">
      {query.error ? <div className="inline"><span className="muted">话题加载失败</span><Button onClick={query.refresh}>重试</Button></div>
        : (hasMore || query.loading) && <Button loading={query.loading} onClick={loadMore}>加载更多</Button>}
    </div>
    {creating && <NewTopic close={() => setCreating(false)} saved={() => { setCreating(false); reload(); }} />}
  </>;
}

function NewTopic({ close, saved }) {
  const [form] = Form.useForm();
  const [files, setFiles] = useState([]);
  const category = Form.useWatch('category', form);
  const { run, busy } = useAction();
  return <Modal open title="发起话题" onCancel={() => !busy && close()} footer={null}>
    <Form form={form} layout="vertical" initialValues={{ category: 'chat' }} disabled={busy}
      onFinish={values => run(async () => {
        const images = await Promise.all(files.map(file => encodeTopicImage(file.originFileObj || file)));
        return API.createTopic({ ...values, images });
      }, '话题已发布', saved)}>
      <Form.Item name="category" label="分类"><Select options={Object.entries(categories).map(([key, label]) => option(key, label))} /></Form.Item>
      <Form.Item name="title" label="话题标题" rules={[filled('请输入话题标题')]}><Input maxLength={80} /></Form.Item>
      {category === 'share' && <Form.Item name="articleUrl" label="文章链接（可选）" preserve={false}>
        <Input inputMode="url" placeholder="https://" maxLength={2048} />
      </Form.Item>}
      <Form.Item name="content" label="正文" dependencies={['articleUrl']} rules={[({ getFieldValue }) => ({
        validator: (_, value) => value?.trim() || files.length || (category === 'share' && getFieldValue('articleUrl')?.trim())
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

function TopicCard({ topic, open, updated, deleted, loading, expanded, toggleDiscussion }) {
  const { run, busy, confirm } = useAction();
  const liked = !!topic.liked;
  async function deleteTopic() {
    if (await confirm('删除这个话题？', '话题下的回复、图片和点赞会一并删除。', true)) {
      await run(() => API.deleteTopic(topic.id), '话题已删除', deleted);
    }
  }
  function openCard(event) {
    if (!event.target.closest('button, a')) open();
  }
  return <Card className={open ? 'topic-card topic-card-clickable' : 'topic-card'} onClick={open ? openCard : undefined}>
    <div className="inline topic-card-heading">
      <h3>{open ? <button type="button" className="topic-title-button" onClick={open}>{topic.title}</button> : topic.title}</h3>
      <Tag color={colors[topic.category]}>{categories[topic.category]}</Tag>
    </div>
    <div className="muted">{topic.authorName || '成员'} · {timeText(topic.createdAt)}</div>
    {topic.content && <p className={`discussion-text${open ? ' topic-preview' : ''}`}>{topic.content}</p>}
    {topic.articleUrl && <a className="article-link" href={topic.articleUrl} target="_blank" rel="noopener noreferrer">打开文章 ↗</a>}
    {topic.imageCount > 0 && <TopicImages topicId={topic.id} count={topic.imageCount} compact={!!open} />}
    <div className="topic-actions inline">
      <Button type="text" danger={liked} aria-pressed={liked} loading={busy} disabled={loading}
        title={liked ? '取消点赞' : '点赞'} onClick={() => run(() => API.setTopicLike(topic.id, !liked), null, updated)}>
        {liked ? '♥ 已点赞' : '♡ 点赞'} {topic.likeCount ?? 0}
      </Button>
      <Button type="link" aria-expanded={expanded} aria-controls={`topic-replies-${topic.id}`} onClick={toggleDiscussion}>
        {expanded ? '收起讨论' : `查看讨论（${topic.replyCount}）`}
      </Button>
      {!!topic.canDelete && <Button type="text" className="topic-delete" disabled={busy || loading} onClick={deleteTopic}>删除话题</Button>}
    </div>
    <div id={`topic-replies-${topic.id}`} hidden={!expanded} onClick={event => event.stopPropagation()}>
      {expanded && <TopicReplies topicId={topic.id} replyCount={topic.replyCount} updated={updated} close={toggleDiscussion} />}
    </div>
  </Card>;
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

function TopicReplies({ topicId, replyCount, updated, close }) {
  const [page, setPage] = useState(1);
  const [replyTo, setReplyTo] = useState(null);
  const replyInput = useRef(null);
  const [form] = Form.useForm();
  const query = useLoad(page, () => API.topicReplies(topicId, page), true);
  const { run, busy } = useAction();
  const { run: remove, busy: removing, confirm } = useAction();
  const syncReplyCount = useEffectEvent(total => {
    if (total !== replyCount) updated({ replyCount: total });
  });
  const total = query.data?.total;
  useEffect(() => {
    if (total != null) syncReplyCount(total);
  }, [total]);
  async function deleteReply(id) {
    if (await confirm('删除这条回复？', null, true)) {
      await remove(() => API.deleteTopicReply(topicId, id), '回复已删除', ({ total }) => {
        setReplyTo(current => current?.id === id ? null : current);
        setPage(current => Math.min(current, Math.max(1, Math.ceil(total / query.data.pageSize))));
        query.refresh();
      });
    }
  }
  return <section className="topic-replies stack" aria-label="话题讨论">
    <Load query={query}>{data => <>
      {data.items.length ? data.items.map(reply => <article className="topic-reply" key={reply.id}>
        <div className="row-between">
          <div className="inline topic-reply-meta">
            <strong>{reply.authorName || '成员'}</strong>
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
          <strong>回复 {reply.replyToName || '成员'}</strong>
          <p className="topic-preview">{reply.replyToExcerpt}</p>
        </div>}
        <p className="discussion-text">{reply.content}</p>
      </article>) : <span className="muted">暂无回复</span>}
      <TopicPagination data={data} page={page} changePage={setPage} />
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
        <strong>回复 {replyTo.authorName || '成员'}</strong>
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

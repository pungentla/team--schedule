import React, { useState } from 'react';
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

export default function Discussions({ topicId, back }) {
  return topicId ? <TopicDetail key={topicId} topicId={topicId} back={back} /> : <TopicList />;
}

function TopicDetail({ topicId, back }) {
  const query = useLoad(topicId, () => API.discussionTopic(topicId), true);
  return <>
    <Card size="small"><Button type="link" onClick={back}>← 返回话题列表</Button></Card>
    <Load query={query}>{topic => <TopicCard topic={topic} updated={query.refresh} loading={query.loading} initiallyExpanded />}</Load>
  </>;
}

function TopicList() {
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const query = useLoad(page, () => API.discussionTopics(page), true);
  return <>
    <Card><div className="row-between">
      <Heading>互动区</Heading>
      <Button type="primary" onClick={() => setCreating(true)}>发起话题</Button>
    </div></Card>
    <Load query={query}>{data => <>
      {data.items.length ? data.items.map(topic => <TopicCard key={topic.id} topic={topic} updated={query.refresh} loading={query.loading} />)
        : <Card><Blank>还没有话题</Blank></Card>}
      <TopicPagination data={data} page={page} changePage={next => { setPage(next); window.scrollTo(0, 0); }} />
    </>}</Load>
    {creating && <NewTopic close={() => setCreating(false)} saved={() => { setCreating(false); setPage(1); query.refresh(); window.scrollTo(0, 0); }} />}
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

function TopicCard({ topic, updated, loading, initiallyExpanded = false }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { run, busy } = useAction();
  const liked = !!topic.liked;
  return <Card className="topic-card">
    <div className="inline topic-card-heading">
      <h3>{topic.title}</h3>
      <Tag color={colors[topic.category]}>{categories[topic.category]}</Tag>
    </div>
    <div className="muted">{topic.authorName || '成员'} · {timeText(topic.createdAt)}</div>
    {topic.content && <p className={`discussion-text${expanded ? '' : ' topic-preview'}`}>{topic.content}</p>}
    {topic.articleUrl && <a className="article-link" href={topic.articleUrl} target="_blank" rel="noopener noreferrer">打开文章 ↗</a>}
    {topic.imageCount > 0 && (expanded ? <TopicImages topicId={topic.id} />
      : <div><Button className="topic-image-link" type="link" onClick={() => setExpanded(true)}>查看图片（{topic.imageCount}）</Button></div>)}
    <div className="topic-actions inline">
      <Button type="text" danger={liked} aria-pressed={liked} loading={busy} disabled={loading}
        title={liked ? '取消点赞' : '点赞'} onClick={() => run(() => API.setTopicLike(topic.id, !liked), null, updated)}>
        {liked ? '♥ 已点赞' : '♡ 点赞'} {topic.likeCount ?? 0}
      </Button>
      <Button type="link" aria-expanded={expanded} aria-controls={`topic-replies-${topic.id}`} onClick={() => setExpanded(value => !value)}>
        {expanded ? '收起讨论' : `查看讨论（${topic.replyCount}）`}
      </Button>
    </div>
    <div id={`topic-replies-${topic.id}`} hidden={!expanded}>
      {expanded && <TopicReplies topicId={topic.id} updated={updated} />}
    </div>
  </Card>;
}

function TopicImages({ topicId }) {
  const query = useLoad(topicId, () => API.topicImages(topicId));
  return <Load query={query}>{images => <div className="topic-images">
    <Image.PreviewGroup>{images.map(image => <Image key={image.position} src={image.src} alt={`话题图片 ${image.position}`} />)}</Image.PreviewGroup>
  </div>}</Load>;
}

function TopicReplies({ topicId, updated }) {
  const [page, setPage] = useState(1);
  const [form] = Form.useForm();
  const query = useLoad(page, () => API.topicReplies(topicId, page), true);
  const { run, busy } = useAction();
  return <section className="topic-replies stack" aria-label="话题讨论">
    <Load query={query}>{data => <>
      {data.items.length ? data.items.map(reply => <article className="topic-reply" key={reply.id}>
        <div className="row-between"><strong>{reply.authorName || '成员'}</strong><time className="muted" dateTime={reply.createdAt}>{timeText(reply.createdAt)}</time></div>
        <p className="discussion-text">{reply.content}</p>
      </article>) : <span className="muted">暂无回复</span>}
      <TopicPagination data={data} page={page} changePage={setPage} />
    </>}</Load>
    <Form form={form} className="topic-reply-form" layout="vertical" disabled={busy} onFinish={({ content }) => run(
      () => API.replyToTopic(topicId, content), '回复已发布', reply => {
        form.resetFields();
        setPage(reply.page);
        query.refresh();
        updated();
      }
    )}>
      <Form.Item name="content" label="发表回复" rules={[filled('请输入回复内容')]}>
        <Input.TextArea rows={2} maxLength={2000} />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>发布回复</Button>
    </Form>
  </section>;
}

function TopicPagination({ data, page, changePage }) {
  return <Pagination simple size="small" hideOnSinglePage current={page} total={data.total}
    pageSize={data.pageSize} onChange={changePage} />;
}

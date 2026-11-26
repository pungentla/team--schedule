import React, { useEffect, useRef, useState } from 'react';
import App from 'antd/es/app';
import Button from 'antd/es/button';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import QRCode from 'antd/es/qr-code';
import Tabs from 'antd/es/tabs';
import { Load, useLoad } from './shared';
import { scheduleLink, scheduleLines } from './scheduleSharing.mjs';

async function poster(date, day, periodName, qr) {
  await document.fonts.ready;
  const width=720,pad=32,inner=width-pad*2,canvas=document.createElement('canvas'),context=canvas.getContext('2d'),draw=[];
  const family='system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  function text(value,x,top,maxWidth,size=25,color='#1f2a3c',bold=false) {
    const font=`${bold?700:400} ${size}px ${family}`;context.font=font;
    const lines=[];let line='';
    for(const character of value) {
      if(character==='\n'||context.measureText(line+character).width>maxWidth){lines.push(line);line='';}
      if(character!=='\n')line+=character;
    }
    lines.push(line);
    draw.push(()=>{context.font=font;context.fillStyle=color;lines.forEach((value,i)=>context.fillText(value,x,top+i*size*1.4));});
    return lines.length*size*1.4;
  }
  function rect(x,top,w,h,color) {draw.push(()=>{context.fillStyle=color;context.fillRect(x,top,w,h);});}
  let y=28;
  y+=text('时禾 · 传3:2 栽种有时',pad,y,inner,25,'#2e59ae',true)+12;
  y+=text(`${date} · 生效安排`,pad,y,inner,32,'#1f2a3c',true)+8;
  if(periodName)y+=text(periodName,pad,y,inner,21,'#64748b')+10;
  for(const shift of day?.shifts || []) {
    y+=12;rect(pad,y,inner,42,'#edf3fc');text(shift.shiftName,pad+12,y+5,inner-24,25,'#2e59ae',true);y+=48;
    for(const [index,work] of shift.workTypes.entries()) {
      const top=y,insert=draw.length;
      const names=work.assigned.map(p=>`${p.name}${p.dutyRole==='primary'?'（主）':p.dutyRole==='deputy'?'（副）':''}`).join('、')||'无人';
      const count=work.fillAllEnrolled?`${work.filled} 人\n最少 ${work.needCount}`:`${work.filled}/${work.needCount}`;
      const missing=[...(work.gap?[`缺 ${work.gap}`]:[]),...(work.roleGaps||[]).map(role=>role==='primary'?'缺主':'缺副')];
      const a=text(work.workTypeName,pad+12,top+12,154,24,'#1f2a3c',true);
      const b=text(names,pad+190,top+12,354,25);
      const c=text([count,...missing].join('\n'),pad+560,top+12,84,21,missing.length?'#c43c32':'#25834c');
      const height=Math.max(36,a,b,c)+24;
      draw.splice(insert,0,()=>{context.fillStyle=index%2?'#f6f8fc':'#fff';context.fillRect(pad,top,inner,height);});
      y+=height;rect(pad,y,inner,1,'#e6ebf3');
    }
  }
  if(!day?.shifts?.length)y+=text('当天暂无安排',pad,y+20,inner,26,'#64748b')+30;
  const qrTop=y+24,height=qrTop+128+pad;
  if(height>4096)throw new Error('当天安排较多，请使用图文链接分享，避免图片文字过小');
  canvas.width=width*2;canvas.height=Math.ceil(height*2);context.scale(2,2);
  context.fillStyle='#fff';context.fillRect(0,0,width,height);context.textBaseline='top';draw.forEach(paint=>paint());
  context.imageSmoothingEnabled=false;context.drawImage(qr,width-pad-128,qrTop,128,128);
  context.fillStyle='#2e59ae';context.font=`700 24px ${family}`;context.fillText('扫码查看最新安排',pad,qrTop+16);
  context.fillStyle='#64748b';context.font=`20px ${family}`;context.fillText('登录时禾后查看',pad,qrTop+58);context.fillText('图片为分享时的快照',pad,qrTop+94);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('生成图片失败，请重试');
  return new File([blob],`时禾排班-${date}.png`,{type:'image/png'});
}
export default function ScheduleShare({ date, day, period, close }) {
  const {message}=App.useApp(),input=useRef(null),[tab,setTab]=useState('link');
  const url=scheduleLink(window.location.href,date,period?.id),lines=scheduleLines(date,day,period?.name);
  const text=`【时禾 · 排班安排】\n${lines.map(l=>l.text).join('\n')}\n${url}`;
  async function copy() {try{await navigator.clipboard.writeText(text);message.success('图文链接已复制');}catch{input.current?.focus({cursor:'all'});message.info('请复制选中的图文链接');}}
  async function share(data) {try{await navigator.share(data);}catch(e){if(e.name!=='AbortError')message.info('可复制链接或保存图片后分享');}}
  return <Modal open width={520} title={<span className="inline">分享排班<small className="muted" style={{fontWeight:400}}>注意信息安全</small></span>} onCancel={close} footer={null}>
    <Tabs activeKey={tab} onChange={setTab} items={[
      {key:'link',label:'图文链接',children:<div className="stack"><Input.TextArea ref={input} readOnly aria-label="排班分享文字" value={text} autoSize={{minRows:4,maxRows:9}}/><div className="inline"><Button type="primary" onClick={copy}>复制图文链接</Button>{navigator.share&&<Button onClick={()=>share({text})}>系统分享</Button>}</div><small className="muted">登录后打开对应日期，查看最新生效安排。</small></div>},
      {key:'image',label:'分享图',children:tab==='image'&&<SchedulePoster date={date} day={day} periodName={period?.name} url={url} share={share}/>},
    ]}/>
  </Modal>;
}
function SchedulePoster({date,day,periodName,url,share}) {
  const qr=useRef(null),[preview,setPreview]=useState(null);
  const query=useLoad(url,()=>{const code=qr.current?.querySelector('canvas');if(!code)throw new Error('二维码生成失败，请重试');return poster(date,day,periodName,code);});
  useEffect(()=>{if(!query.data)return;const src=URL.createObjectURL(query.data);setPreview({src,file:query.data});return()=>URL.revokeObjectURL(src);},[query.data]);
  return <div className="stack"><div hidden ref={qr}><QRCode value={url} size={320} bordered={false} bgColor="#fff" color="#111"/></div><Load query={query}>{file=>preview?.file===file&&<><div className="topic-share-image"><img src={preview.src} alt="当天生效排班和二维码分享图"/></div><div className="inline"><Button type="primary" href={preview.src} download={file.name}>保存图片</Button>{navigator.canShare?.({files:[file]})&&<Button onClick={()=>share({files:[file]})}>系统分享</Button>}</div><small className="muted">长按可保存图片，扫码查看最新安排。</small></>}</Load></div>;
}

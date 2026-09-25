(()=>{
'use strict';
if(globalThis.__wvfs_v6__)return;
globalThis.__wvfs_v6__=true;
const TOP=window===window.top;
let enabled=false,controller=null,observer=null,timer=null,rate=1.5;
const watched=new WeakSet();
const playbackSeen=new WeakSet();
const attemptedAutoPlay=new WeakSet();
const autoPlayRunning=new WeakSet();
const noAutoplay=new WeakSet();
// Each HTML5 video holds the episode resolved from its TOP-LEVEL tab URL.
const resumeJobs=new WeakMap();
const resumeInfo=new WeakMap();
const resumeGeneration=new WeakMap();
const restoring=new WeakSet();
const finishedVideos=new WeakSet();
const lastCheckpoint=new WeakMap();
const RESUME_SAVE_INTERVAL=5000;
function resetResume(v){
  resumeGeneration.set(v,(resumeGeneration.get(v)||0)+1);
  resumeJobs.delete(v);resumeInfo.delete(v);lastCheckpoint.delete(v);
  finishedVideos.delete(v);attemptedAutoPlay.delete(v);noAutoplay.delete(v);
  playbackSeen.delete(v);
}
function eligibleForResume(v){
  return enabled && v?.isConnected && v.readyState>=1 &&
    Number.isFinite(v.duration) && v.duration>=60 &&
    (areaOf(v)>=4000 || v.videoWidth>0);
}
function ensureResume(v){
  if(!eligibleForResume(v)||v.readyState<2)return Promise.resolve();
  if(resumeJobs.has(v))return resumeJobs.get(v);
  const generation=resumeGeneration.get(v)||0;
  const job=(async()=>{
    const answer=await send({type:'WVFS_RESUME_GET'});
    if(!answer?.ok||!enabled||!v.isConnected||
       (resumeGeneration.get(v)||0)!==generation)return;
    resumeInfo.set(v,{episode:answer.episode});
    const checkpoint=answer.checkpoint;
    if(!checkpoint || !Number.isFinite(checkpoint.position) ||
       !Number.isFinite(checkpoint.duration))return;
    // Avoid applying the position of a different stream to a changed episode.
    if(Math.abs(v.duration-checkpoint.duration)>Math.max(30,v.duration*.08))return;
    if(checkpoint.position<5 || checkpoint.position>=v.duration-5)return;
    // Do not override a position the viewer has already chosen manually.
    if(v.currentTime>5)return;
    let target=Math.max(0,Math.min(checkpoint.position,v.duration-3));
    try{
      if(v.seekable.length){
        let closest=null,delta=Infinity;
        for(let i=0;i<v.seekable.length;i++){
          const start=v.seekable.start(i),end=v.seekable.end(i);
          const candidate=Math.max(start,Math.min(target,end));
          if(Math.abs(candidate-target)<delta){closest=candidate;delta=Math.abs(candidate-target);}
        }
        if(closest!==null)target=closest;
      }
      if(target<5)return;
      restoring.add(v);
      const seeked=new Promise(resolve=>{
        const done=()=>{v.removeEventListener('seeked',done);resolve();};
        v.addEventListener('seeked',done,{once:true});
        setTimeout(done,1500);
      });
      v.currentTime=target;
      await seeked;
    }catch{
      // A player may reject seeking until it has loaded more data.
    }finally{restoring.delete(v);}
  })();
  resumeJobs.set(v,job);
  return job;
}
function saveCheckpoint(v,force=false){
  if(!eligibleForResume(v)||restoring.has(v)||finishedVideos.has(v)||v.ended)return;
  const info=resumeInfo.get(v);
  if(!info?.episode)return;  // Never save under the third-party iframe URL.
  const now=Date.now();
  if(!force && now-(lastCheckpoint.get(v)||0)<RESUME_SAVE_INTERVAL)return;
  if(!Number.isFinite(v.currentTime)||v.currentTime<5||v.currentTime>=v.duration-3)return;
  lastCheckpoint.set(v,now);
  return send({type:'WVFS_RESUME_SAVE',episode:info.episode,
    position:v.currentTime,duration:v.duration});
}
// Chrome의 소리 있는 autoplay가 막히면 무음 재생을 시도하고 상단 바에 안내한다.
async function tryAutoplay(v){
  if(!enabled||!v||!v.isConnected||!v.paused||v.ended||v.error||
     attemptedAutoPlay.has(v)||autoPlayRunning.has(v)||noAutoplay.has(v))return;
  // 로딩 중에 재생 시도를 소진하지 않도록 canplay / loadeddata 시점까지 대기.
  if(v.readyState<2 || (Number.isFinite(v.duration)&&v.duration>0&&v.duration<60))return;
  if(!Number.isFinite(v.duration) && areaOf(v)<4000)return;
  autoPlayRunning.add(v);
  try{
    await ensureResume(v);
    if(!enabled||!v.isConnected||v.ended)return;
    speed(v);
    try{
      await v.play();
      attemptedAutoPlay.add(v);
    }catch(e){
      if(e?.name!=='NotAllowedError'){
        // 별도 이유(아직 로딩, 재생소스 교체 등)라면 다음 scan에서 재시도.
        if(e?.name==='NotSupportedError')noAutoplay.add(v);
        return;
      }
      // 오디오 자동재생은 브라우저 정책에 따라 차단될 수 있음.
      // 음소거된 자동재생만 허용되면 영상을 끊기지 않게 재생한다.
      v.muted=true;
      try{
        await v.play();
        attemptedAutoPlay.add(v);
        send({type:'WVFS_AUTOPLAY_MUTED'});
      }catch(err){
        if(err?.name==='NotAllowedError')noAutoplay.add(v);
      }
    }
  }finally{
    autoPlayRunning.delete(v);
    report();
  }
}

const send=msg=>chrome.runtime.sendMessage(msg).catch(()=>null);

const onReady=fn=>{
  if(document.documentElement)fn();
  else document.addEventListener('DOMContentLoaded',fn,{once:true});
};
function allVideos(){
  const output=[];
  const queue=[document];
  let n=0;
  while(queue.length && n++<150){
    const root=queue.shift();
    try{
      output.push(...root.querySelectorAll('video'));
      for(const el of root.querySelectorAll('*'))if(el.shadowRoot)queue.push(el.shadowRoot);
    }catch{}
  }
  return [...new Set(output)].filter(v=>v.isConnected);
}
function areaOf(v){
  try{
    const r=v.getBoundingClientRect();
    return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*
           Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
  }catch{return 0;}
}
function rank(v){
  return (!v.paused&&!v.ended?1e7:0)+
    (Number.isFinite(v.duration)&&v.duration>=60?3e6:0)+
    Math.min(1e6,areaOf(v))+(v.currentTime>0?1e5:0);
}
function bestVideo(){
  return allVideos().sort((a,b)=>rank(b)-rank(a))[0]||null;
}
function speed(v){
  if(!v)return false;
  try{
    if(Math.abs(v.defaultPlaybackRate-rate)>.001)v.defaultPlaybackRate=rate;
    if(Math.abs(v.playbackRate-rate)>.001)v.playbackRate=rate;
    return Math.abs(v.playbackRate-rate)<.01;
  }catch{return false;}
}
function report(){
  if(!enabled)return;
  const list=allVideos(),v=bestVideo();
  return send({type:'WVFS_REPORT',report:{
    videos:list.length, playing:v?!v.paused&&!v.ended:false,
    duration:v?.duration,currentTime:v?.currentTime,rate:v?.playbackRate,
    area:v?areaOf(v):0
  }});
}
function listen(v){
  if(watched.has(v))return;
  watched.add(v);
  const onChange=()=>{
    if(!enabled)return;
    if(!v.paused&&!v.ended){playbackSeen.add(v);attemptedAutoPlay.add(v);}
    speed(v);report();
  };
  ['play','playing','loadedmetadata','loadeddata','canplay','durationchange','seeking','seeked','emptied'].forEach(
    type=>v.addEventListener(type,()=>{onChange();if(type!=='seeking'&&type!=='seeked')tryAutoplay(v); }));
  v.addEventListener('timeupdate',()=>saveCheckpoint(v));
  v.addEventListener('pause',()=>saveCheckpoint(v,true));
  v.addEventListener('seeked',()=>saveCheckpoint(v,true));
  v.addEventListener('emptied',()=>resetResume(v));
  v.addEventListener('ratechange',()=>{
    if(enabled && Math.abs(v.playbackRate-rate)>.01)
      setTimeout(()=>{if(enabled)speed(v);},90);
  });
  v.addEventListener('ended',()=>{
    if(!enabled||!v.ended||!playbackSeen.has(v))return;
    // 광고/짧은 클립은 제외. muted 상태에서도 완료 이벤트는 인정.
    if(!Number.isFinite(v.duration)||v.duration<60||v.currentTime<v.duration-5)return;
    finishedVideos.add(v);
    const episode=resumeInfo.get(v)?.episode;
    report()?.then(async()=>{
      if(episode)await send({type:'WVFS_RESUME_COMPLETE',episode});
      send({type:'WVFS_ENDED'});
    });
  });
}
function scan(){
  const list=allVideos();
  for(const v of list){
    listen(v);
    if(enabled){
      if(!v.paused&&!v.ended){playbackSeen.add(v);attemptedAutoPlay.add(v);}
      speed(v);
      ensureResume(v);
      tryAutoplay(v);
    }
  }
  if(enabled)report();
  if(TOP)controller?.update();
}
function settings(state){
  if(enabled&&!state?.enabled){
    for(const v of allVideos()){
      saveCheckpoint(v,true);
      // A later click may reuse the same video node: fetch the checkpoint again.
      resetResume(v);
    }
  }
  enabled=!!state?.enabled;
  const requested=Number(state?.speed);
  rate=Number.isFinite(requested)&&requested>=1&&requested<=2 ? Math.round(requested*20)/20 : 1.5;
  onReady(()=>{
    scan();
    if(TOP){
      if(!controller)controller=makeControls();
      controller.sync();controller.update();
    }
    // Top frame monitors dynamic player/SPA changes even before first activation;
    // child iframe scripts only monitor their videos when enabled.
    if(!enabled && !TOP){
      observer?.disconnect();observer=null;
      clearInterval(timer);timer=null;
      return;
    }
    if(!observer){
      observer=new MutationObserver(()=>scan());
      observer.observe(document.documentElement,{childList:true,subtree:true});
    }
    if(!timer)timer=setInterval(scan,1700);
  });
}
function rewind5(){
  const v=bestVideo();
  if(!v)return {ok:false,error:'현재 프레임에서 HTML5 동영상을 찾지 못했습니다.'};
  try{
    const start=v.seekable.length?v.seekable.start(0):0;
    const destination=Math.max(0,start,v.currentTime-5);
    if(destination>=v.currentTime-.05)return {ok:false,error:'영상의 시작 부분입니다.'};
    v.currentTime=destination;
    setTimeout(report,150);
    return {ok:true,message:'5초 뒤로 이동 완료'};
  }catch{return {ok:false,error:'이 영상은 현재 위치 이동을 허용하지 않습니다.'};}
}
function skip(){
  const v=bestVideo();
  if(!v)return {ok:false,error:'현재 프레임에서 HTML5 동영상을 찾지 못했습니다.'};
  try{
    let end=Number.isFinite(v.duration)?v.duration:Infinity;
    if(v.seekable.length)end=Math.min(end,v.seekable.end(v.seekable.length-1));
    if(!Number.isFinite(end))return {ok:false,error:'건너뛸 수 있는 재생 범위를 알 수 없습니다.'};
    const dest=Math.min(v.currentTime+85,Math.max(0,end-.15));
    if(dest<=v.currentTime+.05)return {ok:false,error:'영상의 끝입니다.'};
    v.currentTime=dest;
    setTimeout(report,150);
    return {ok:true,message:'85초 건너뛰기 완료'};
  }catch{return {ok:false,error:'이 영상은 현재 위치 이동을 허용하지 않습니다.'};}
}
function parseOhliEpisode(href){
  try{
    const u=new URL(href);
    if(u.hostname!=='ani.ohli24.com'||!/^\/e\//.test(u.pathname))return null;
    const label=decodeURIComponent(u.pathname.slice(3).replace(/\/$/,'')).trim();
    const match=label.match(/^(.*?)\s+(\d+)\s*화\s*(?:\((完)\))?$/u);
    if(!match)return null;
    return {
      url:u.href,
      title:match[1].trim(),
      number:Number(match[2]),
      complete:!!match[3]
    };
  }catch{return null;}
}
function ohliLink(direction){
  const current=parseOhliEpisode(location.href);
  const siteReady=location.hostname==='ani.ohli24.com' && !!current;
  if(!siteReady)return {ok:true,siteReady:false,href:null};
  const targetNumber=current.number+direction;
  if(targetNumber<1)return {ok:true,siteReady:true,href:null};
  const links=[...document.querySelectorAll('a[href]')]
    .map(a=>parseOhliEpisode(a.href))
    .filter(Boolean)
    .filter(item=>item.title===current.title && item.number===targetNumber);
  const unique=[...new Map(links.map(item=>[item.url,item])).values()];
  unique.sort((a,b)=>Number(b.complete)-Number(a.complete));
  return {ok:true,siteReady:true,href:unique[0]?.url||null};
}
function ohliNavigate(direction,expected){
  const result=ohliLink(direction);
  if(!result.href||result.href!==expected)return {ok:false,error:'회차 링크가 변경되었습니다.'};
  const link=[...document.querySelectorAll('a[href]')]
    .find(a=>{try{return new URL(a.href).href===expected;}catch{return false;}});
  if(!link)return {ok:false};
  link.click();
  return {ok:true,url:expected};
}
function nativeLink(direction){
  const siteReady=location.hostname==='kf.carsstore365.com' &&
    /\/watch\/?$/.test(location.pathname) && !!document.getElementById('player-area');
  const selector=direction===-1?'a.nav-button.prev-ep[href]':'a.nav-button.next-ep[href]';
  const link=siteReady?document.querySelector('#player-area '+selector):null;
  return {ok:true,siteReady,href:link?.href||null};
}
function nativeNavigate(direction,expected){
  const {href}=nativeLink(direction);
  if(!href||href!==expected)return {ok:false,error:'회차 링크가 변경되었습니다.'};
  const link=document.querySelector('#player-area '+
    (direction===-1?'a.nav-button.prev-ep[href]':'a.nav-button.next-ep[href]'));
  if(!link)return {ok:false};
  link.click();
  return {ok:true,url:href};
}
function makeControls(){
  const saved=new Map();
  let target=null,anchor=null,toastTimer=null,speedSaveTimer=null;
  function keep(el){if(el&&!saved.has(el))saved.set(el,el.getAttribute('style'));}
  function set(el,k,v){keep(el);el.style.setProperty(k,v,'important');}
  function restore(){
    for(const [el,style] of [...saved].reverse()){
      if(style===null)el.removeAttribute('style');
      else el.setAttribute('style',style);
    }
    saved.clear();target=null;
  }
  function visible(el){
    const st=getComputedStyle(el);
    if(st.display==='none'||st.visibility==='hidden')return 0;
    const r=el.getBoundingClientRect();
    return Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*
           Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
  }
  function pick(){
    const site=document.querySelector('#player-area .video-wrapper:has(iframe#video-player-iframe)');
    if(site&&visible(site)>4000)return site;
    const video=bestVideo();
    if(video&&visible(video)>4000)return video.closest('.html5-video-player,.jwplayer,.video-js,.plyr,.dplayer,.art-video-player')||video.parentElement;
    return [...document.querySelectorAll('iframe')]
      .filter(el=>visible(el)>4000 && !/adsbygoogle|google_ads/i.test(el.id||''))
      .map(el=>({el,weight:visible(el)*(/player|embed|video|stream|play\.php/i.test(el.src)?3:1)}))
      .sort((a,b)=>b.weight-a.weight)[0]?.el?.parentElement||null;
  }
  function expand(el){
    set(document.documentElement,'overflow','hidden');
    if(document.body)set(document.body,'overflow','hidden');
    for(let p=el.parentElement;p&&p!==document.body&&p!==document.documentElement;p=p.parentElement){
      ['transform','filter','perspective','contain','clip-path'].forEach(k=>set(p,k,'none'));
      set(p,'overflow','visible');
      if(getComputedStyle(p).position==='static')set(p,'position','relative');
      set(p,'z-index','2147483644');
    }
    target=el;
    for(const [key,val] of Object.entries({
      position:'fixed',inset:'0',width:'100vw',height:'100dvh',
      'min-width':'0','min-height':'0','max-width':'none','max-height':'none',
      margin:'0',padding:'0','padding-bottom':'0',border:'0','border-radius':'0',
      transform:'none','aspect-ratio':'auto',background:'black','z-index':'2147483646'
    }))set(el,key,val);
    dispatchEvent(new Event('resize'));
  }
  function update(){
    // Only the Chrome extension icon activates the UI.
    if(!enabled){
      if(target)restore();
      root.remove();anchor=null;
      return;
    }
    const el=pick();
    if(!el){if(target)restore();root.remove();anchor=null;return;}
    // The site replaces .video-wrapper on SPA episode transitions.
    if(el!==anchor||!root.isConnected){
      if(target)restore();
      anchor=el;
      expand(el);
      el.appendChild(root);
    }else if(target!==el){
      if(target)restore();
      expand(el);
    }
  }
  const root=document.createElement('div');
  root.id='wvfs-v6-bar';
  Object.assign(root.style,{
    position:'absolute',top:'8px',right:'8px',zIndex:'2147483647',
    pointerEvents:'auto',maxWidth:'calc(100% - 16px)',colorScheme:'dark'
  });
  const shadow=root.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>
    :host{all:initial;font-family:system-ui,-apple-system,sans-serif;color:white}
    .bar{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:center;
      max-width:min(95vw,680px);padding:0;background:transparent;border:0;
      border-radius:0;box-shadow:none}
    .bar button{box-sizing:border-box;cursor:pointer;border-radius:8px;color:#fff;
      background:#273348;border:0;height:36px;font:12px system-ui,sans-serif;
      padding:0 10px;white-space:nowrap}
    button:hover{background:#354662!important}button:focus-visible,input:focus-visible{outline:2px solid #a5d8ff}
    .speed{box-sizing:border-box;display:flex;gap:8px;align-items:center;height:36px;
      background:#283348;border:0;border-radius:8px;padding:0 9px;
      font:12px system-ui,sans-serif;white-space:nowrap}
    #speed{width:142px;cursor:pointer;accent-color:#72cbff}
    #speed-value{font:700 13px system-ui,sans-serif;min-width:43px;text-align:right}
    #msg{display:none;position:absolute;right:0;top:100%;margin-top:5px;
      min-width:180px;max-width:min(90vw,440px);width:max-content;white-space:pre-wrap;
      line-height:1.45;word-break:break-word;color:white;background:#111827f7;
      border:1px solid #8791a7;border-radius:8px;box-shadow:0 4px 15px #000a;
      padding:11px;font:12px system-ui,sans-serif}
  </style>
  <div class="bar">
    <button id="rewind">⏪ -5초</button>
    <button id="skip">⏩ 85초</button>
    <button id="prev">⏮ 이전 화</button>
    <button id="next">⏭ 다음 화</button>
    <label class="speed" for="speed">배속 <input id="speed" type="range" min="1" max="2" step="0.05" value="1.5" aria-label="재생속도 1배에서 2배, 0.05 간격"><output id="speed-value">1.50×</output></label>
    <button id="close">닫기</button>
  </div><div id="msg" role="status"></div>`;
  const $=id=>shadow.getElementById(id);
  function toast(message,duration=5200){
    const el=$('msg');el.textContent=message;el.style.display='block';
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.style.display='none',duration);
  }
  $('rewind').onclick=async()=>{
    const r=await send({type:'WVFS_COMMAND',command:'rewind5'});
    if(!r?.ok)toast(r?.error||'5초 뒤로 이동하지 못했습니다.');
  };
  $('skip').onclick=async()=>{
    const r=await send({type:'WVFS_COMMAND',command:'skip'});
    if(!r?.ok)toast(r?.error||'85초 이동에 실패했습니다.');
  };
  $('close').onclick=()=>send({type:'WVFS_TOGGLE'});
  $('prev').onclick=async()=>{
    const r=await send({type:'WVFS_PREV'});
    if(!r?.ok)toast(r?.error||'이전 화로 이동하지 못했습니다.');
  };
  $('next').onclick=async()=>{
    const r=await send({type:'WVFS_NEXT'});
    if(!r?.ok)toast(r?.error||'다음 화로 이동하지 못했습니다.');
  };
  $('speed').oninput=()=>{
    const value=Math.round(Number($('speed').value)*20)/20;
    $('speed-value').textContent=value.toFixed(2)+'×';
    clearTimeout(speedSaveTimer);
    speedSaveTimer=setTimeout(()=>send({type:'WVFS_SET_SPEED',value}).then(r=>{
      if(!r?.ok)toast(r?.error||'배속을 저장하지 못했습니다.');
    }),90);
  };
  $('speed').onchange=()=>{
    clearTimeout(speedSaveTimer);
    const value=Math.round(Number($('speed').value)*20)/20;
    send({type:'WVFS_SET_SPEED',value}).then(r=>{
      if(!r?.ok)toast(r?.error||'배속을 저장하지 못했습니다.');
    });
  };
  function keydown(ev){
    if(enabled&&ev.key==='Escape'&&!ev.defaultPrevented){
      ev.preventDefault();ev.stopImmediatePropagation();send({type:'WVFS_TOGGLE'});
    }
  }
  document.addEventListener('keydown',keydown,true);
  function sync(){
    if(shadow.activeElement!==$('speed'))$('speed').value=String(rate);
    $('speed-value').textContent=rate.toFixed(2)+'×';
  }
  function noticeMuted(){
    toast('크롬이 소리 있는 자동재생을 차단하여 음소거 재생했습니다. 소리는 영상 플레이어에서 켜 주세요.',10000);
  }
  return {update,sync,noticeMuted};
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  if(m?.type==='WVFS_SETTINGS'){settings(m.state);respond({ok:true});}
  else if(m?.type==='WVFS_PROBE'){if(enabled)scan();respond({ok:true});}
  else if(m?.type==='WVFS_AUTOPLAY_NOTICE'&&TOP){controller?.noticeMuted();respond({ok:true});}
  else if(m?.type==='WVFS_CHECKPOINT_FLUSH'){
    const saves=enabled?allVideos().map(v=>saveCheckpoint(v,true)).filter(Boolean):[];
    Promise.all(saves).then(()=>respond({ok:true})).catch(()=>respond({ok:false}));
    return true;
  }
  else if(m?.type==='WVFS_EPISODE_CHANGED'){
    for(const v of allVideos())resetResume(v);
    if(enabled)setTimeout(scan,400);
    respond({ok:true});
  }
  else if(m?.type==='WVFS_NATIVE_LINK'&&TOP){respond(nativeLink(m.direction));}
  else if(m?.type==='WVFS_OHLI_LINK'&&TOP){respond(ohliLink(m.direction));}
  else if(m?.type==='WVFS_OHLI_NAVIGATE'&&TOP){respond(ohliNavigate(m.direction,m.url));}
  else if(m?.type==='WVFS_NATIVE_NAVIGATE'&&TOP){respond(nativeNavigate(m.direction,m.url));}
  else if(m?.type==='WVFS_MEDIA_COMMAND'){
    if(!enabled){respond({ok:false,error:'비활성 상태입니다.'});return;}
    if(m.command==='skip')respond(skip());
    else if(m.command==='rewind5')respond(rewind5());
    else respond({ok:false});
  }
});
// Best effort on tab close/reload; frequent checkpoints cover cases where
// a document is torn down before its final message can be delivered.
addEventListener('pagehide',()=>{
  if(enabled)for(const v of allVideos())saveCheckpoint(v,true);
});
// Apply changed preferences to already-open tabs as well as newly opened episode pages.
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes.wvfs_v5_preferences?.newValue)return;
  const prefs=changes.wvfs_v5_preferences.newValue;
  settings({enabled,speed:prefs.speed});
});
send({type:'WVFS_READY'}).then(res=>{if(res?.state)settings(res.state);else if(TOP)settings({enabled:false});});
})();
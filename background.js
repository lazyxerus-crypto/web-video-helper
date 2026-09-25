'use strict';
// v6: Extension icon toggles overlay. Autoplay and auto-next are always on while enabled.
const KEY = 'wvfs_v5_preferences';
const tabKey = id => `wvfs_v5_tab_${id}`;
const DEFAULTS = {speed:1.5};
const frames = new Map();
const navLocks = new Set();
const recentMoves = new Map();
function validSpeed(n){return typeof n==='number' && Number.isFinite(n) && n>=1 && n<=2 && Math.abs(n*20-Math.round(n*20))<.0001;}
async function prefsFor(){
  const stored=(await chrome.storage.local.get(KEY))[KEY]||{};
  return {...DEFAULTS,speed:validSpeed(stored.speed)?Math.round(stored.speed*20)/20:1.5};
}
async function updatePrefs(patch){
  const next={...await prefsFor(),...patch};
  await chrome.storage.local.set({[KEY]:next});
  return next;
}
async function stateFor(tabId){return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)]||null;}
async function saveState(tabId,state){await chrome.storage.session.set({[tabKey(tabId)]:state});}
function originOf(href){try{return new URL(href).origin;}catch{return '';}}
function permitted(sender,state){return state?.enabled && sender.tab?.url && originOf(sender.tab.url)===state.origin;}
const dispatch=(tabId,msg,options)=>chrome.tabs.sendMessage(tabId,msg,options);
async function tellFrames(tabId,msg){try{await dispatch(tabId,msg);}catch{}}
async function stateForReady(sender){
  const tabId=sender.tab.id, origin=originOf(sender.tab.url), prefs=await prefsFor();
  let state=await stateFor(tabId);
  // New tabs and unrelated websites are off; same-origin episode changes keep this tab's activation.
  if(!state || state.origin!==origin){
    state={enabled:false,origin};
    await saveState(tabId,state);
  }
  return {...state,...prefs,enabled:state.enabled,origin};
}
async function toggle(tab){
  if(!tab?.id || !/^https?:/i.test(tab.url||''))return {ok:false};
  const old=await stateFor(tab.id), prefs=await prefsFor();
  const enabled=!(old?.enabled && old.origin===originOf(tab.url));
  
  const state={enabled,origin:originOf(tab.url),...prefs};
  await saveState(tab.id,{enabled,origin:state.origin});
  frames.delete(tab.id);navLocks.delete(tab.id);
  await tellFrames(tab.id,{type:'WVFS_SETTINGS',state});
  await chrome.action.setBadgeText({tabId:tab.id,text:enabled?'ON':''}).catch(()=>{});
  return {ok:true,enabled};
}
chrome.action.onClicked.addListener(tab=>toggle(tab).catch(console.warn));
// Numeric fallback is only used for generic sites without first-class episode links.
function changeSlug(href,direction){
  try{
    const u=new URL(href),slug=u.searchParams.get('slug');
    if(slug && /^\d+$/.test(slug)){
      const n=BigInt(slug)+BigInt(direction);
      if(n<1n)return null;
      u.searchParams.set('slug',n.toString().padStart(slug.length,'0'));
      return u.href;
    }
    const match=u.pathname.match(/(\d+)(\/?)$/);
    if(match){
      const n=BigInt(match[1])+BigInt(direction);
      if(n<1n)return null;
      u.pathname=u.pathname.slice(0,-match[0].length)+n.toString().padStart(match[1].length,'0')+match[2];
      return u.href;
    }
  }catch{}
  return null;
}
// The DOM link is authored by the site's episode data: slugs need not be numbers.
function validAdjacentLink(current,proposed){
  try{
    const a=new URL(current),b=new URL(proposed,current);
    const oldSlug=a.searchParams.get('slug'),newSlug=b.searchParams.get('slug');
    return a.origin===b.origin && a.pathname===b.pathname &&
      a.searchParams.get('server')===b.searchParams.get('server') &&
      Boolean(oldSlug) && Boolean(newSlug) && oldSlug!==newSlug &&
      b.protocol==='https:' && !b.username && !b.password;
  }catch{return false;}
}
async function adjacentURL(tabId,href,direction){
  const u=new URL(href);
  if(u.hostname==='kf.carsstore365.com' && /\/watch\/?$/.test(u.pathname)){
    const result=await dispatch(tabId,{type:'WVFS_NATIVE_LINK',direction},{frameId:0}).catch(()=>null);
    if(result?.siteReady && !result.href)
      return {error:direction===1?'이 작품의 다음 화가 없습니다.':'이 작품의 이전 화가 없습니다.'};
    if(result?.href && validAdjacentLink(href,result.href))
      return {url:new URL(result.href,href).href,native:true};
    if(result?.href)return {error:'회차 링크가 현재 작품/서버와 맞지 않습니다.'};
    // Site-ready or not: do not invent a slug when the site's data may use 04a etc.
    return {error:'사이트 회차 링크를 찾지 못했습니다. 플레이어가 로드된 뒤 다시 시도하세요.'};
  }
  const url=changeSlug(href,direction);
  return url?{url,native:false}:{error:'사이트에 다음/이전 회차 링크가 없고 숫자 회차도 아닙니다.'};
}
async function advance(tabId,href,direction=1){
  const old=recentMoves.get(tabId);
  if(old && Date.now()-old.at<4500 && old.from===href)return {ok:false,error:'회차 이동 중입니다.'};
  if(navLocks.has(tabId))return {ok:false,error:'회차 이동 중입니다.'};
  const state=await stateFor(tabId);
  if(!state?.enabled||state.origin!==originOf(href))return {ok:false,error:'크롬 확장 프로그램 아이콘을 눌러 활성화해 주세요.'};
  const adjacent=await adjacentURL(tabId,href,direction);
  if(adjacent.error)return {ok:false,error:adjacent.error};
  if(originOf(adjacent.url)!==state.origin)return {ok:false,error:'다른 사이트로 자동 이동하지 않습니다.'};
  navLocks.add(tabId);recentMoves.set(tabId,{at:Date.now(),from:href,to:adjacent.url});frames.delete(tabId);
  try{
    if(adjacent.native){
      const clicked=await dispatch(tabId,{type:'WVFS_NATIVE_NAVIGATE',direction,url:adjacent.url},{frameId:0}).catch(()=>null);
      if(clicked?.ok){
        setTimeout(()=>navLocks.delete(tabId),1700);
        return {ok:true,url:adjacent.url};
      }
    }
    await chrome.tabs.update(tabId,{url:adjacent.url});
    return {ok:true,url:adjacent.url};
  }catch(e){navLocks.delete(tabId);recentMoves.delete(tabId);return {ok:false,error:String(e)};}
}
function score(r){return (r.playing?1e7:0)+(r.duration>=60?3e6:0)+Math.min(1e6,r.area||0)+(r.currentTime>0?1e5:0);}
function pick(tabId){
  const list=frames.get(tabId);
  if(!list)return null;
  return [...list.entries()].filter(([,r])=>r.videos>0&&Date.now()-r.at<12000)
    .sort((a,b)=>score(b[1])-score(a[1]))[0]||null;
}
async function probe(tabId){await tellFrames(tabId,{type:'WVFS_PROBE'});await new Promise(r=>setTimeout(r,300));}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  const tabId=sender.tab?.id;
  if(typeof tabId!=='number')return;
  (async()=>{
    if(message?.type==='WVFS_READY')return {ok:true,state:await stateForReady(sender)};
    const state=await stateFor(tabId);
    if(message?.type==='WVFS_TOGGLE'){
      if(sender.frameId!==0)return {ok:false};
      return toggle(sender.tab);
    }
    if(!permitted(sender,state))return {ok:false,error:'크롬 확장 프로그램 아이콘을 눌러 활성화해 주세요.'};
    if(message?.type==='WVFS_REPORT'){
      if(!frames.has(tabId))frames.set(tabId,new Map());
      const r=message.report||{};
      frames.get(tabId).set(sender.frameId,{
        at:Date.now(),doc:sender.documentId,
        videos:Math.max(0,Number(r.videos)||0),playing:!!r.playing,
        duration:Number.isFinite(r.duration)?r.duration:0,
        currentTime:Number(r.currentTime)||0,rate:Number(r.rate)||0,area:Number(r.area)||0
      });
      return {ok:true};
    }
    if(message?.type==='WVFS_SET_SPEED'){
      if(sender.frameId!==0)return {ok:false};
      const speed=Number(message.value);
      if(!validSpeed(speed))return {ok:false,error:'1.00~2.00 사이, 0.05 간격으로 지정하세요.'};
      const prefs=await updatePrefs({speed:Math.round(speed*20)/20});
      await tellFrames(tabId,{type:'WVFS_SETTINGS',state:{...state,...prefs}});
      return {ok:true,speed:prefs.speed};
    }
    if(message?.type==='WVFS_COMMAND'){
      if(sender.frameId!==0)return {ok:false};
      if(!['skip','rewind5'].includes(message.command))return {ok:false};
      let chosen=pick(tabId);
      if(!chosen){await probe(tabId);chosen=pick(tabId);}
      if(!chosen)return {ok:false,error:'동영상을 찾지 못했습니다. 재생을 시작한 뒤 다시 눌러주세요.'};
      try{return await dispatch(tabId,{type:'WVFS_MEDIA_COMMAND',command:message.command},{frameId:chosen[0]});}
      catch{return {ok:false,error:'영상 프레임에 접근하지 못했습니다. 사이트 액세스 권한을 확인하세요.'};}
    }
    if(message?.type==='WVFS_NEXT'||message?.type==='WVFS_PREV'){
      if(sender.frameId!==0)return {ok:false};
      return advance(tabId,sender.tab.url,message.type==='WVFS_PREV'?-1:1);
    }
    if(message?.type==='WVFS_AUTOPLAY_MUTED'){
      await dispatch(tabId,{type:'WVFS_AUTOPLAY_NOTICE'},{frameId:0}).catch(()=>{});
      return {ok:true};
    }
    if(message?.type==='WVFS_ENDED'){
      const r=frames.get(tabId)?.get(sender.frameId);
      if(!r||r.doc!==sender.documentId||r.duration<60||r.currentTime<r.duration-5)
        return {ok:false,error:'본편 종료가 확인되지 않았습니다.'};
      return advance(tabId,sender.tab.url,1);
    }
    return {ok:false};
  })().then(respond).catch(e=>respond({ok:false,error:String(e)}));
  return true;
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{
  if(change.status==='loading'){frames.delete(id);navLocks.delete(id);}
  if(change.url || change.status==='complete'){
    stateFor(id).then(s=>{
      if(s?.enabled&&tab.url&&originOf(tab.url)!==s.origin){
        saveState(id,{enabled:false,origin:originOf(tab.url)}).catch(()=>{});
        chrome.action.setBadgeText({tabId:id,text:''}).catch(()=>{});
      }
    }).catch(()=>{});
  }
});
chrome.tabs.onRemoved.addListener(id=>{
  frames.delete(id);navLocks.delete(id);recentMoves.delete(id);
  chrome.storage.session.remove(tabKey(id)).catch(()=>{});
});
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function parseOhliEpisode(href){
  try{
    const u = new URL(href);
    if(u.hostname!=='ani.ohli24.com'||!/^\/e\//.test(u.pathname))return null;
    const label=decodeURIComponent(u.pathname.slice(3).replace(/\/$/,'')).trim();
    const match=label.match(/^(.*?)\s+(\d+)\s*화\s*(?:\((完)\))?$/u);
    if(!match)return null;
    return {
      url:u.href,title:match[1].trim(),number:Number(match[2]),complete:!!match[3]
    };
  }catch{return null;}
}

function validOhliLink(current,proposed,direction){
  const a=parseOhliEpisode(current),b=parseOhliEpisode(proposed);
  return !!a && !!b && a.title===b.title &&
    b.number===a.number+direction &&
    b.url.startsWith('https://ani.ohli24.com/e/');
}

test('Ohli24 parses ordinary episode URLs',()=>{
  const ep2=parseOhliEpisode('https://ani.ohli24.com/e/%EB%94%94%20%ED%94%8C%EB%9E%98%EA%B7%B8!%202%ED%99%94');
  const ep3=parseOhliEpisode('https://ani.ohli24.com/e/%EB%94%94%20%ED%94%8C%EB%9E%98%EA%B7%B8!%203%ED%99%94');
  assert.deepEqual(
    {title:ep2.title,number:ep2.number,complete:ep2.complete},
    {title:'디 플래그!',number:2,complete:false}
  );
  assert.equal(validOhliLink(ep2.url,ep3.url,1),true);
  assert.equal(validOhliLink(ep3.url,ep2.url,-1),true);
});

test('Ohli24 recognizes the final episode marker',()=>{
  const final=parseOhliEpisode('https://ani.ohli24.com/e/%EB%8B%B4%EB%B0%B0%20%EA%B3%A0%EC%96%91%EC%9D%B4%2012%ED%99%94(%E5%AE%8C)');
  const prev=parseOhliEpisode('https://ani.ohli24.com/e/%EB%8B%B4%EB%B0%B0%20%EA%B3%A0%EC%96%91%EC%9D%B4%2011%ED%99%94');
  assert.deepEqual(
    {title:final.title,number:final.number,complete:final.complete},
    {title:'담배 고양이',number:12,complete:true}
  );
  assert.equal(validOhliLink(prev.url,final.url,1),true);
  assert.equal(validOhliLink(final.url,prev.url,-1),true);
});

test('Ohli24 does not connect different series with the same episode number',()=>{
  const a='https://ani.ohli24.com/e/%EB%94%94%20%ED%94%8C%EB%9E%98%EA%B7%B8!%202%ED%99%94';
  const b='https://ani.ohli24.com/e/%EB%8B%B4%EB%B0%B0%20%EA%B3%A0%EC%96%91%EC%9D%B4%203%ED%99%94';
  assert.equal(validOhliLink(a,b,1),false);
});

test('Ohli24 does not use non-Ohli hosts',()=>{
  const a='https://ani.ohli24.com/e/%EB%94%94%20%ED%94%8C%EB%9E%98%EA%B7%B8!%202%ED%99%94';
  const b='https://example.com/e/%EB%94%94%20%ED%94%8C%EB%9E%98%EA%B7%B8!%203%ED%99%94';
  assert.equal(validOhliLink(a,b,1),false);
});

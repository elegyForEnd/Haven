'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAnimeService, select, template, normalizeSubject } = require('../src/anime-service');
const { createMediaRelay, isPublicAddress } = require('../src/anime-media');
const { createAnimeStore } = require('../src/anime-store');
const register = require('../src/routes/anime');

test('JSON adapter parses subscription fields and escapes search terms without executing selectors', () => {
  assert.deepEqual(select({ sources: [{ episodes: [{ id: 1 }, { id: 2 }] }] }, '$.sources[*].episodes[*].id'), [1,2]);
  assert.throws(() => select({}, '$[?(@.constructor)]'));
  const body = template('{"q":"{keyword}","page":{page}}', { keyword: 'a"\\\nb', page: 1 }, 'json');
  assert.deepEqual(JSON.parse(body), { q: 'a"\\\nb', page: 1 });
  assert.equal(template('https://example.com?q={keyword}', { keyword: 'A&B' }), 'https://example.com?q=A%26B');
  assert.equal(normalizeSubject({id:1,name:'原名',name_cn:'',images:{large:'http://lain.bgm.tv/a.jpg'}}).image,'https://lain.bgm.tv/a.jpg');
});

test('resolver matches the exact season, selected episode and all returned playback candidates', async () => {
  let playCalls = 0;
  const adapter = { id: 'test', factoryId:'json-api', arguments: { name:'Test', searchConfig: {
    baseUrl:'https://source.example', search:{ request:{url:'/search?q={keyword}'},selectItems:'$[*]',selectName:'$.title',selectId:'$.id' },
    subject:{request:{url:'/subject/{id}'},channelFormatId:'grouped',channelFormatGrouped:{selectChannels:'$.sources[*]'},episodes:{selectEpisodes:'$.episodes[*]',selectName:'$.title',selectId:'$.id',selectSort:'$.sort',selectType:'$.kind'}},
    play:{request:{url:'/play/{id}'},selectCandidates:'$.candidates[*]',selectVideoUrl:'$.url',selectCandidateChannel:'$.name'}
  } } };
  const service = createAnimeService({ fetchImpl: async url => {
    let data;
    if (url.includes('/v0/subjects/')) data = { id:1,type:2,name:'Test Show',name_cn:'番剧',rating:{score:8},images:{} };
    else if (url.includes('css1.json')) data = {mediaSources:[adapter]};
    else if (url.includes('/search')) data = [{id:99,title:'番剧 第二季'},{id:7,title:'另一种译名',title_original:'Test Show'}];
    else if (url.includes('/subject/7')) data = { sources:[{episodes:[{id:71,sort:1,kind:'main',title:'第一话'},{id:72,sort:2,kind:'main',title:'第二话'}]}] };
    else if (url.includes('/play/72')) { playCalls++; data = {candidates:[{name:'A',url:'https://cdn.example/a.mp4'},{name:'B',url:'https://cdn.example/b.m3u8'}]}; }
    else throw new Error('Unexpected request: '+url);
    return {ok:true,json:async()=>data};
  } });
  const result = await service.resolve(1,2);
  assert.equal(playCalls,1);
  assert.deepEqual(result.streams.map(s=>s.type),['video','hls']);
  assert.equal((await service.resolve(1,3)).streams.length,0);
});

test('media relay rejects private networks and rewrites HLS playlists, keys and relative segments to capabilities', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.20.0.1','::1','fc00::1','::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  const relay = createMediaRelay();
  assert.throws(()=>relay.issue('http://127.0.0.1/test'));
  const text = relay.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\n../segment.ts\n','https://cdn.example/video/index.m3u8','');
  assert.match(text, /URI="\/api\/anime\/media\/[a-f0-9]+"/);
  assert.equal(text.includes('cdn.example'),false);
  assert.equal(text.split('/api/anime/media/').length-1,3);
});

test('authenticated library is isolated by account, durable, and validates comments, likes and progress', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ciacord-anime-test-'));
  const app = express(); app.use(express.json()); const store = createAnimeStore(dir);
  register({ app,dataDir:dir,store,verifyToken:async value=>value === 'user-1' ? {id:1,username:'One'} : value === 'user-2' ? {id:2,username:'Two'} : null,
    service:{home:async()=>({featured:[]}),resolve:async()=>({streams:[],errors:[]})} });
  const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  t.after(async()=>{ await new Promise(r=>server.close(r)); store.close(); await fs.rm(dir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}/api/anime`;
  const call = (p,body,user='user-1',method='POST')=>fetch(base+p,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${user}`},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  assert.equal((await fetch(base+'/library')).status,401);
  assert.equal((await call('/library/400602',{status:'doing',episode:8,position:30,duration:100,watched:[1,2]},'user-1','PUT')).status,200);
  let rows = await (await call('/library',undefined,'user-2','GET')).json(); assert.equal(rows.items.length,0);
  rows = await (await call('/library',undefined,'user-1','GET')).json(); assert.deepEqual(rows.items[0].watched,[1,2]);
  assert.equal((await call('/library/400602',{position:-1},'user-1','PUT')).status,400);
  assert.equal((await call('/library/400602',{watched:['1']},'user-1','PUT')).status,400);
  assert.equal((await call('/subjects/400602/comments/8',{content:'<script>bad</script>',spoiler:true})).status,201);
  let comments=await(await fetch(base+'/subjects/400602/comments/8')).json();
  assert.equal(comments.items[0].content,'<script>bad</script>'); // UI escapes all upstream/user strings.
  const commentId = comments.items[0].id;
  await call(`/comments/${commentId}/like`,{});
  comments=await(await call('/subjects/400602/comments/8',undefined,'user-1','GET')).json();
  assert.equal(comments.items[0].likes,1); assert.equal(comments.items[0].liked,1);
  await call(`/comments/${commentId}/like`,{});
  assert.equal(store.comments(400602,8,1)[0].likes,0);
  assert.equal((await call('/subjects/400602/danmaku/8',{time:12,text:'hello'})).status,201);
  assert.equal((await(await fetch(base+'/subjects/400602/danmaku/8')).json()).items[0].time,12);
  assert.equal((await call('/subjects/400602/danmaku/8',{time:-1,text:'hello'})).status,400);
  assert.equal((await fetch(base+'/media/missing')).status,410);
  assert.equal((await fetch(base+'/subjects/bad/play/1')).status,400);
  const reopen = createAnimeStore(dir); assert.equal(reopen.library(1)[0].episode,8); reopen.close();
});

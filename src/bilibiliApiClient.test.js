'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWbiMixinKey,
  normalizeDashFormats,
  parseCanonicalVideoUrl,
  resolveBilibiliPlaybackInfo,
  signWbiParameters
} = require('./bilibiliApiClient');
const {
  mapQrLoginState,
  splitCombinedSetCookieHeader
} = require('./bilibiliAuth');

function createJsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('WBI signing produces a deterministic sorted signature', () => {
  const mixinKey = createWbiMixinKey(
    '7cd084941338484aae1ad9425b84077c',
    '4932caff0ff746eab6f01bf08b70ac45'
  );
  assert.equal(mixinKey, 'ea1db124af3c7062474693fa704f4ff8');

  const signedQuery = signWbiParameters({
    foo: 'one one four',
    bar: '514',
    baz: '1919810'
  }, mixinKey, 1702204169);
  assert.equal(
    signedQuery,
    'bar=514&baz=1919810&foo=one%20one%20four&wts=1702204169&w_rid=c4e16b82e758eadda1303cd7b687a727'
  );
});

test('canonical Bilibili URLs preserve the selected page', () => {
  assert.deepEqual(
    parseCanonicalVideoUrl('https://www.bilibili.com/video/BV1234567890?p=3'),
    { bvid: 'BV1234567890', page: 3 }
  );
  assert.throws(
    () => parseCanonicalVideoUrl('https://example.test/video/BV1234567890'),
    /canonical Bilibili/
  );
  assert.throws(
    () => parseCanonicalVideoUrl('https://www.bilibili.com/video/BV1234567890?p=2abc'),
    /page parameter/
  );
});

test('playback resolution rejects a requested page that does not exist', async () => {
  const fetchImpl = async url => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.pathname, '/x/web-interface/view');
    return createJsonResponse({
      code: 0,
      data: {
        title: 'One-page video',
        pages: [{ page: 1, cid: 12345, part: 'Part one' }]
      }
    });
  };
  await assert.rejects(
    resolveBilibiliPlaybackInfo(
      'https://www.bilibili.com/video/BV1234567890?p=2',
      {
        fetchImpl,
        requestCredential: { cookieHeader: '', credentialVersion: 'anonymous' }
      }
    ),
    /page 2 does not exist/
  );
});

test('DASH normalization exposes H.264 and AAC candidates with server-only request headers', () => {
  const normalized = normalizeDashFormats({
    timelength: 120000,
    dash: {
      video: [{
        id: 64,
        baseUrl: 'https://video.example.test/720.m4s',
        codecs: 'avc1.640028',
        width: 1280,
        height: 720,
        frameRate: '30000/1001',
        bandwidth: 1500000
      }],
      audio: [{
        id: 30280,
        baseUrl: 'https://audio.example.test/audio.m4s',
        codecs: 'mp4a.40.2',
        bandwidth: 192000
      }]
    }
  }, { Cookie: 'SESSDATA=secret', Referer: 'https://www.bilibili.com/' });

  assert.equal(normalized.duration, 120);
  assert.equal(normalized.formats[0].vcodec, 'avc1.640028');
  assert.equal(normalized.formats[0].fps > 29, true);
  assert.equal(normalized.formats[1].acodec, 'mp4a.40.2');
  assert.equal(normalized.formats[1].http_headers.Cookie, 'SESSDATA=secret');
});

test('playback resolution calls view, nav, and signed playurl APIs with the server credential', async () => {
  const capturedRequests = [];
  const fetchImpl = async (url, options) => {
    const requestUrl = new URL(url);
    capturedRequests.push({ requestUrl, options });
    if (requestUrl.pathname === '/x/web-interface/view') {
      return createJsonResponse({
        code: 0,
        data: {
          title: 'Test video',
          pages: [{ page: 1, cid: 12345, part: 'Part one' }]
        }
      });
    }
    if (requestUrl.pathname === '/x/web-interface/nav') {
      return createJsonResponse({
        code: 0,
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
          }
        }
      });
    }
    if (requestUrl.pathname === '/x/player/wbi/playurl') {
      return createJsonResponse({
        code: 0,
        data: {
          timelength: 90000,
          dash: {
            video: [{
              id: 16,
              baseUrl: 'https://video.example.test/360.m4s?deadline=4102444800',
              codecs: 'avc1.64001e',
              width: 640,
              height: 360,
              frameRate: '30',
              bandwidth: 500000
            }],
            audio: [{
              id: 30280,
              baseUrl: 'https://audio.example.test/audio.m4s?deadline=4102444800',
              codecs: 'mp4a.40.2',
              bandwidth: 192000
            }]
          }
        }
      });
    }
    throw new Error(`Unexpected Bilibili API request: ${requestUrl.pathname}`);
  };

  const playbackInfo = await resolveBilibiliPlaybackInfo(
    'https://www.bilibili.com/video/BV1234567890',
    {
      fetchImpl,
      requestCredential: {
        cookieHeader: 'SESSDATA=server-secret',
        credentialVersion: 'test-credential'
      }
    }
  );

  assert.equal(playbackInfo.cid, 12345);
  assert.equal(playbackInfo.formats.length, 2);
  assert.equal(capturedRequests.length, 3);
  assert.equal(capturedRequests.every(request => request.options.headers.Cookie === 'SESSDATA=server-secret'), true);
  assert.equal(playbackInfo.formats.every(format => !format.http_headers.Cookie), true);
  const playbackRequest = capturedRequests.find(request => request.requestUrl.pathname === '/x/player/wbi/playurl');
  assert.equal(playbackRequest.requestUrl.searchParams.get('cid'), '12345');
  assert.equal(playbackRequest.requestUrl.searchParams.get('qn'), '127');
  assert.match(playbackRequest.requestUrl.searchParams.get('w_rid'), /^[a-f0-9]{32}$/);
});

test('QR helpers preserve Expires dates and map Bilibili states', () => {
  const setCookieHeader = 'buvid3=device; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, SESSDATA=session-value; Path=/; HttpOnly';
  const splitHeaders = splitCombinedSetCookieHeader(setCookieHeader);
  assert.equal(splitHeaders.length, 2);
  assert.equal(splitHeaders[0].includes('Wed, 21 Oct 2026'), true);
  assert.equal(mapQrLoginState(86101), 'not_scanned');
  assert.equal(mapQrLoginState(86090), 'scanned_waiting_confirmation');
  assert.equal(mapQrLoginState(86038), 'expired');
  assert.equal(mapQrLoginState(0), 'success');
});

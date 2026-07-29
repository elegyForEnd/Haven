'use strict';

const fs = require('fs');
const { pipeline } = require('stream');

function setCommonHeaders(response) {
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function endRequest(response, statusCode, reason) {
  if (!response.headersSent) response.setHeader('X-Haven-Bilibili-HLS-Status', reason);
  response.status(statusCode).end();
}

function parseByteRange(rangeHeader, fileSize) {
  if (rangeHeader === undefined) return null;
  if (typeof rangeHeader !== 'string' || rangeHeader.length > 100) return false;
  const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!rangeMatch || (!rangeMatch[1] && !rangeMatch[2])) return false;

  let startByte;
  let endByte;
  if (!rangeMatch[1]) {
    const suffixLength = Number(rangeMatch[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    startByte = Math.max(0, fileSize - suffixLength);
    endByte = fileSize - 1;
  } else {
    startByte = Number(rangeMatch[1]);
    endByte = rangeMatch[2] ? Number(rangeMatch[2]) : fileSize - 1;
  }

  if (!Number.isSafeInteger(startByte)
    || !Number.isSafeInteger(endByte)
    || startByte < 0
    || endByte < startByte
    || startByte >= fileSize) return false;
  return { startByte, endByte: Math.min(endByte, fileSize - 1) };
}

function createBilibiliHlsAssetHandler(options) {
  const lookupAsset = options.lookupAsset;
  return async function handleBilibiliHlsAsset(request, response) {
    setCommonHeaders(response);
    if (!['GET', 'HEAD'].includes(request.method)) return endRequest(response, 405, 'method-not-allowed');

    const lookup = lookupAsset(
      request.params?.trackId,
      request.params?.sessionVersion,
      request.params?.assetName
    );
    if (lookup.status === 'expired') return endRequest(response, 410, 'session-expired');
    if (lookup.status !== 'active' || !lookup.asset) return endRequest(response, 404, 'asset-not-found');

    const asset = lookup.asset;
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('Accept-Ranges', 'bytes');
    if (asset.assetName === 'index.m3u8') {
      let playlistBuffer;
      try {
        playlistBuffer = await fs.promises.readFile(asset.path);
      } catch {
        return endRequest(response, 404, 'asset-not-found');
      }
      response.setHeader('Cache-Control', 'private, no-store');
      const playlistRange = parseByteRange(request.headers.range, playlistBuffer.length);
      if (playlistRange === false) {
        response.setHeader('Content-Range', `bytes */${playlistBuffer.length}`);
        return endRequest(response, 416, 'invalid-range');
      }
      if (playlistRange) {
        response.status(206);
        response.setHeader(
          'Content-Range',
          `bytes ${playlistRange.startByte}-${playlistRange.endByte}/${playlistBuffer.length}`
        );
        const responseBuffer = playlistBuffer.subarray(playlistRange.startByte, playlistRange.endByte + 1);
        response.setHeader('Content-Length', responseBuffer.length);
        response.end(request.method === 'HEAD' ? undefined : responseBuffer);
        return;
      }
      response.status(200);
      response.setHeader('Content-Length', playlistBuffer.length);
      response.end(request.method === 'HEAD' ? undefined : playlistBuffer);
      return;
    }

    let assetStat;
    try {
      assetStat = await fs.promises.stat(asset.path);
    } catch {
      return endRequest(response, 404, 'asset-not-found');
    }
    if (!assetStat.isFile()) return endRequest(response, 404, 'asset-not-found');

    response.setHeader('Cache-Control', 'private, max-age=3600, immutable');

    const byteRange = parseByteRange(request.headers.range, assetStat.size);
    if (byteRange === false) {
      response.setHeader('Content-Range', `bytes */${assetStat.size}`);
      return endRequest(response, 416, 'invalid-range');
    }

    let streamOptions;
    if (byteRange) {
      response.status(206);
      response.setHeader('Content-Range', `bytes ${byteRange.startByte}-${byteRange.endByte}/${assetStat.size}`);
      response.setHeader('Content-Length', byteRange.endByte - byteRange.startByte + 1);
      streamOptions = { start: byteRange.startByte, end: byteRange.endByte };
    } else {
      response.status(200);
      response.setHeader('Content-Length', assetStat.size);
    }

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const assetStream = fs.createReadStream(asset.path, streamOptions);
    response.once('close', () => {
      if (!response.writableEnded) assetStream.destroy();
    });
    pipeline(assetStream, response, error => {
      if (error && !response.destroyed) response.destroy(error);
    });
  };
}

module.exports = {
  createBilibiliHlsAssetHandler,
  parseByteRange
};

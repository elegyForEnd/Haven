// Feed compressed GameStream video into the existing MediaStream-based viewer.
// The sender uses Annex B H.264. Derive the codec string from its first SPS.
function h264Codec(data) {
  for (let i = 0; i + 6 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const nal = data[i + 2] === 1 ? i + 3 :
      data[i + 2] === 0 && data[i + 3] === 1 ? i + 4 : -1;
    if (nal < 0 || nal + 3 >= data.length || (data[nal] & 0x1f) !== 7) continue;
    return 'avc1.' + Array.from(data.subarray(nal + 1, nal + 4),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function opusDurationUs(data) {
  if (data.length === 0) return 0;
  const config = data[0] >> 3;
  const duration = config < 12 ? [10000, 20000, 40000, 60000][config & 3] :
    config < 16 ? [10000, 20000][config & 1] : [2500, 5000, 10000, 20000][config & 3];
  const code = data[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (data[1] & 0x3f) : 2;
  return duration * frames <= 120000 ? duration * frames : 0;
}

export function createGameStreamPlayback({ requestKeyFrame, onError }) {
  const track = new MediaStreamTrackGenerator({ kind: 'video' });
  const stream = new MediaStream([track]);
  const writer = track.writable.getWriter();
  const audioTrack = new MediaStreamTrackGenerator({ kind: 'audio' });
  const audioWriter = audioTrack.writable.getWriter();
  stream.addTrack(audioTrack);
  let pendingWrite = false;
  let pendingAudio = 0;
  let audioTimeUs = 0;
  let closed = false;
  let needsKeyFrame = true;
  let codec = null;

  const decoder = new VideoDecoder({
    output(frame) {
      if (closed || pendingWrite) {
        frame.close();
        return;
      }
      pendingWrite = true;
      writer.write(frame).catch(error => {
        if (!closed) onError(error);
      }).finally(() => {
        frame.close();
        pendingWrite = false;
      });
    },
    error(error) {
      if (!closed) onError(error);
    },
  });
  const audioDecoder = new AudioDecoder({
    output(audio) {
      if (closed || pendingAudio >= 16) {
        audio.close();
        return;
      }
      pendingAudio++;
      audioWriter.write(audio).catch(error => {
        if (!closed) onError(error);
      }).finally(() => {
        audio.close();
        pendingAudio--;
      });
    },
    error(error) {
      if (!closed) onError(error);
    },
  });
  audioDecoder.configure({ codec: 'opus', numberOfChannels: 2, sampleRate: 48000 });

  return {
    stream,
    resetVideo() {
      if (closed || decoder.state === 'closed') return;
      decoder.reset();
      codec = null;
      needsKeyFrame = true;
      requestKeyFrame();
    },
    push({ video, data, keyFrame, timestampUs }) {
      if (!video) {
        const duration = opusDurationUs(data);
        if (closed || audioDecoder.state !== 'configured' || !duration) return;
        const timestamp = audioTimeUs;
        audioTimeUs += duration;
        if (audioDecoder.decodeQueueSize >= 16) return;
        try {
          audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, duration, data }));
        } catch (error) {
          onError(error);
        }
        return;
      }
      if (closed || decoder.state === 'closed' || (needsKeyFrame && !keyFrame)) return;
      try {
        if (decoder.decodeQueueSize >= 6) {
          decoder.reset();
          codec = null;
          needsKeyFrame = true;
          if (!keyFrame) {
            requestKeyFrame();
            return;
          }
        }
        const nextCodec = keyFrame ? h264Codec(data) : null;
        if (nextCodec && nextCodec !== codec) {
          decoder.configure({
            codec: nextCodec,
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency: true,
          });
          codec = nextCodec;
        }
        if (!codec) {
          requestKeyFrame();
          return;
        }
        decoder.decode(new EncodedVideoChunk({
          type: keyFrame ? 'key' : 'delta',
          timestamp: timestampUs,
          data,
        }));
        needsKeyFrame = false;
      } catch (error) {
        onError(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (decoder.state !== 'closed') decoder.close();
      if (audioDecoder.state !== 'closed') audioDecoder.close();
      track.stop();
      audioTrack.stop();
      writer.abort().catch(() => {});
      audioWriter.abort().catch(() => {});
    },
  };
}

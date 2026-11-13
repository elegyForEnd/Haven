const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/stream-performance.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('stream performance uses the selected video transport and both relay candidates', async () => {
  const { webRtcPerformance } = await modulePromise;
  const reports = [
    { id: 'video', type: 'inbound-rtp', kind: 'video', trackIdentifier: 'screen', transportId: 'transport', bytesReceived: 125000 },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected' },
    { id: 'selected', type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.022 },
    { id: 'local', candidateType: 'host' },
    { id: 'remote', candidateType: 'srflx' },
    { id: 'unused-relay', type: 'candidate-pair', localCandidateId: 'relay' },
    { id: 'relay', candidateType: 'relay' },
  ];
  const stats = new Map(reports.map(report => [report.id, report]));
  assert.deepEqual(webRtcPerformance(stats, 'screen'), { route: 'direct', rtt: 22, videoBytes: 125000 });
  stats.get('remote').candidateType = 'relay';
  assert.equal(webRtcPerformance(stats, 'screen').route, 'relay');
  stats.get('remote').candidateType = 'host';
  stats.get('local').candidateType = 'relay';
  assert.equal(webRtcPerformance(stats, 'screen').route, 'relay');
  stats.get('transport').selectedCandidatePairId = 'disconnected';
  assert.equal(webRtcPerformance(stats, 'screen').route, null);
  assert.equal(webRtcPerformance(stats, 'screen').rtt, null);
});

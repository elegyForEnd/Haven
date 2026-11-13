'use strict';

const { createHmac, randomBytes } = require('node:crypto');

const rooms = new WeakMap();
const bootId = randomBytes(16).toString('hex');

function voiceNetworkEnabled(env = process.env) {
  const key = env.HAVEN_EASYTIER_SECRET;
  const prefix = env.HAVEN_EASYTIER_NETWORK_PREFIX;
  const host = env.HAVEN_EASYTIER_HOST;
  const port = Number(env.HAVEN_EASYTIER_PORT || 11010);
  return /^[a-f0-9]{64}$/i.test(key || '') && /^[a-f0-9]{16}$/.test(prefix || '') &&
    /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host || '') && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function getVoiceNetwork(room, userId, env = process.env, subnet = 242) {
  if (!room || !voiceNetworkEnabled(env)) return null;

  let network = rooms.get(room);
  if (!network) {
    const id = randomBytes(16).toString('hex');
    network = {
      name: `haven-${env.HAVEN_EASYTIER_NETWORK_PREFIX}-${id}`,
      secret: createHmac('sha256', env.HAVEN_EASYTIER_SECRET).update(`${bootId}:${id}`).digest('hex'),
      peers: ['udp', 'tcp'].map(protocol =>
        `${protocol}://${env.HAVEN_EASYTIER_HOST}:${Number(env.HAVEN_EASYTIER_PORT || 11010)}`),
      addresses: new Map(),
    };
    rooms.set(room, network);
  }
  if (!network.addresses.has(userId)) {
    const index = network.addresses.size + 1;
    if (index >= 65535) return null;
    network.addresses.set(userId, `10.${subnet}.${index >> 8}.${index & 255}`);
  }
  const { name, secret, peers, addresses } = network;
  return { name, secret, peers, address: addresses.get(userId) };
}

module.exports = { getVoiceNetwork, voiceNetworkEnabled };

export async function setupManualNetwork(app) {
  const panel = document.getElementById('manual-network-panel');
  if (!panel) return;
  const api = (window.ciacordDesktop || window.havenDesktop)?.manualNetwork;
  const canJoin = await api?.available().catch(() => false);
  const button = document.getElementById('manual-network-toggle');
  const list = document.getElementById('manual-network-members');
  let joinedCode, pendingCode, pending = false, refreshing = false, available = false;

  const send = (event, payload) => new Promise(resolve => {
    if (!app.socket.connected) return resolve(null);
    app.socket.timeout(4000).emit(event, payload, (error, response) => resolve(error ? null : response));
  });

  function renderButton() {
    const key = pending ? 'mesh.joining' : joinedCode ? 'mesh.leave' : 'mesh.join';
    button.textContent = t(key);
    button.dataset.i18n = key;
    button.disabled = canJoin && (pending || !available || !app.socket.connected || !app.currentChannel);
  }

  function renderMembers(members, status) {
    list.replaceChildren();
    for (const member of members || []) {
      const row = document.createElement('div');
      const name = document.createElement('span');
      const ip = document.createElement('code');
      name.textContent = member.name;
      ip.textContent = member.address;
      row.append(name, ip);
      if (joinedCode) {
        const route = member.address === status?.address ? 'self' :
          status?.peers?.find(peer => peer.address === member.address)?.route;
        const label = document.createElement('span');
        const key = ['self', 'direct', 'relay'].includes(route) ? route : 'unknown';
        label.className = `manual-network-route manual-network-route-${key}`;
        label.textContent = t(`mesh.${key}`);
        label.title = t('mesh.route_hint');
        row.append(label);
      }
      list.append(row);
    }
    if (!list.childElementCount) list.textContent = t(members ? 'mesh.empty' : 'mesh.unavailable');
  }

  async function leave() {
    joinedCode = null;
    pendingCode = null;
    await api?.leave().catch(() => {});
    if (app.socket.connected) app.socket.emit('manual-network-leave');
    renderButton();
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const code = app.currentChannel;
      if ((joinedCode && joinedCode !== code) || (pendingCode && pendingCode !== code)) await leave();
      const ready = joinedCode === code && !!await api?.active().catch(() => false);
      if (joinedCode && !ready) await leave();
      if (panel.open || ready) {
        const [state, status] = await Promise.all([
          code && send('manual-network', { code, ready }),
          ready && api?.status ? api.status().catch(() => null) : null,
        ]);
        if (code !== app.currentChannel) return;
        available = !!state;
        if (ready && !state?.active) await leave();
        renderMembers(state?.members, status);
      }
      renderButton();
    } finally {
      refreshing = false;
    }
  }

  button.hidden = false;
  panel.hidden = false;
  panel.querySelector('summary').addEventListener('click', event => {
    if (canJoin) return;
    event.preventDefault();
    app._showToast(t('mesh.desktop_required'), 'info');
  });
  panel.addEventListener('toggle', refresh);
  app.socket.on('disconnect', () => {
    available = false;
    renderMembers(null);
    leave();
  });
  app.socket.on('connect', refresh);
  button.addEventListener('click', async () => {
    if (!canJoin) {
      app._showToast(t('mesh.desktop_required'), 'info');
      return;
    }
    if (pending) return;
    if (joinedCode) {
      await leave();
      await refresh();
      return;
    }
    const code = app.currentChannel;
    if (!code) return;
    pending = true;
    pendingCode = code;
    renderButton();
    try {
      const response = await send('manual-network', { code, join: true });
      if (pendingCode !== code || app.currentChannel !== code) return;
      if (!response?.config || !await api.join(response.config)) throw new Error('Network unavailable');
      if (pendingCode === code && app.currentChannel === code && app.socket.connected) joinedCode = code;
    } catch {
      if (pendingCode === code) app._showToast(t('mesh.failed'), 'error');
    } finally {
      if (!joinedCode) await leave();
      pendingCode = null;
      pending = false;
      await refresh();
    }
  });
  setInterval(refresh, 4000);
  renderButton();
}

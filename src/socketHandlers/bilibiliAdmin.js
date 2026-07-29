'use strict';

const {
  cancelBilibiliQrLogin,
  getBilibiliCredentialStatus,
  pollBilibiliQrLogin,
  startBilibiliQrLogin,
  unbindBilibiliAccount
} = require('../bilibiliAuth');
const { clearBilibiliApiCaches } = require('../bilibiliApiClient');
const { clearBilibiliMedia } = require('../bilibiliMedia');

function getCurrentAdmin(db, userId) {
  if (!Number.isInteger(userId)) return null;
  const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(userId);
  return user?.is_admin ? user : null;
}

function emitAdminError(socket, error) {
  socket.emit('bilibili-auth-error', {
    message: String(error?.message || 'Bilibili account operation failed').slice(0, 240)
  });
}

module.exports = function registerBilibiliAdmin(socket, ctx) {
  const { db, logAudit } = ctx;

  socket.on('get-bilibili-auth-status', () => {
    if (!getCurrentAdmin(db, socket.user?.id)) return;
    socket.emit('bilibili-auth-status', getBilibiliCredentialStatus());
  });

  socket.on('start-bilibili-qr-login', async () => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    try {
      const loginSession = await startBilibiliQrLogin(admin.id);
      if (!getCurrentAdmin(db, socket.user?.id)) {
        cancelBilibiliQrLogin(admin.id, loginSession.sessionId);
        throw new Error('Administrator permission was revoked before QR login started');
      }
      socket.emit('bilibili-qr-login-started', loginSession);
      logAudit({
        actor: socket.user,
        action: 'bilibili_binding_started',
        target_type: 'server_integration',
        target_name: 'Bilibili'
      });
    } catch (error) {
      emitAdminError(socket, error);
    }
  });

  socket.on('poll-bilibili-qr-login', async data => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    if (!/^[a-f0-9]{48}$/.test(sessionId)) return;

    try {
      const result = await pollBilibiliQrLogin(admin.id, sessionId, {
        authorizeBeforeSave: () => !!getCurrentAdmin(db, socket.user?.id)
      });
      socket.emit('bilibili-qr-login-status', result);
      if (result.state === 'success') {
        clearBilibiliApiCaches();
        clearBilibiliMedia();
        socket.emit('bilibili-auth-status', result.status);
        logAudit({
          actor: socket.user,
          action: 'bilibili_binding_completed',
          target_type: 'server_integration',
          target_name: result.status?.displayName || 'Bilibili',
          details: { uid: result.status?.uid || null }
        });
      }
    } catch (error) {
      emitAdminError(socket, error);
    }
  });

  socket.on('cancel-bilibili-qr-login', data => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return;
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    cancelBilibiliQrLogin(admin.id, sessionId);
    socket.emit('bilibili-qr-login-status', { state: 'cancelled' });
  });

  socket.on('unbind-bilibili-account', () => {
    const admin = getCurrentAdmin(db, socket.user?.id);
    if (!admin) return emitAdminError(socket, new Error('Admin only'));
    try {
      const previousStatus = getBilibiliCredentialStatus();
      const status = unbindBilibiliAccount();
      clearBilibiliApiCaches();
      clearBilibiliMedia();
      socket.emit('bilibili-auth-status', status);
      logAudit({
        actor: socket.user,
        action: 'bilibili_binding_removed',
        target_type: 'server_integration',
        target_name: previousStatus.displayName || 'Bilibili',
        details: { uid: previousStatus.uid || null }
      });
    } catch (error) {
      emitAdminError(socket, error);
    }
  });
};

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('main UI does not surface Android or recovery-code prompts', () => {
  const appHtml = fs.readFileSync(path.join(ROOT, 'public/app.html'), 'utf8');
  const clientSource = [
    'public/js/modules/app-platform.js',
    'public/js/modules/app-socket.js',
    'public/js/modules/app-utilities.js',
  ].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  const userHandlers = fs.readFileSync(path.join(ROOT, 'src/socketHandlers/users.js'), 'utf8');

  assert.doesNotMatch(appHtml, /id=["']android-beta-banner["']/);
  assert.doesNotMatch(clientSource, /recovery-notice-state|_showRecoveryNotice|_syncAndroidBanner/);
  assert.doesNotMatch(userHandlers, /get-recovery-notice-state|recovery-notice-state/);
});

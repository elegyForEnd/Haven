'use strict';

const path = require('node:path');

module.exports = function registerDesktopClient({ app, dataDir }) {
  // A fixed path outside the image lets the operator publish updates atomically.
  const installer = path.join(dataDir, 'clients', 'Ciacord-Setup-latest.exe');
  app.get('/downloads/ciacord/latest/windows-x64', (req, res, next) => {
    res.download(installer, 'Ciacord-Setup-latest.exe', {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' },
      dotfiles: 'deny',
    }, error => {
      if (!error) return;
      if (res.headersSent) return next(error);
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Desktop client download is not available yet.' });
      next(error);
    });
  });
};

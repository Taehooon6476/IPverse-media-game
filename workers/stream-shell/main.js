// IPverse web player for Amazon GameLift Streams (Windows Server 2022 runtime): one full-screen Chromium window
// (Electron) that opens an IPverse three.js game on the stream host's GPU. The game URL comes from the stream
// session (AdditionalEnvironmentVariables IPVERSE_GAME_URL, or --url=…); only the studio's own CloudFront games
// are allowed, anything else shows the studio home.
const { app, BrowserWindow, session } = require('electron');

const HOME = 'https://d12ka835iwfpnx.cloudfront.net/';
const ALLOWED = /^https:\/\/d12ka835iwfpnx\.cloudfront\.net\/games\/gm_[A-Za-z0-9_-]+\/index\.html(\?[\w=&.%-]*)?$/;

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function gameUrl() {
  const arg = process.argv.find((a) => a.startsWith('--url='));
  const url = process.env.IPVERSE_GAME_URL || (arg ? arg.slice(6) : '');
  return ALLOWED.test(url) ? url : HOME;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'pointerLock' || permission === 'fullscreen'));
  const win = new BrowserWindow({
    width: 1920, height: 1080, fullscreen: true, kiosk: true, frame: false, autoHideMenuBar: true, backgroundColor: '#000000',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenu(null);
  // stay on the game: no popups, no navigation away from allowed pages
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!ALLOWED.test(url) && !url.startsWith(HOME)) e.preventDefault(); });
  win.loadURL(gameUrl());
});

app.on('window-all-closed', () => app.quit());

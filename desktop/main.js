// Docmore desktop: an Electron window around your own Docmore server.
// The server address is asked once and kept; the session (cookies) lives
// in the app, web notifications become native ones, outside links open in
// the system browser, and docmore:// links land in the window.
const { app, BrowserWindow, Menu, shell, ipcMain, nativeTheme, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
};
const writeSettings = (patch) => {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
};

let win = null;
let pendingDeepLink = null;

const isOurs = (url) => {
  const server = readSettings().serverUrl;
  if (!server) return false;
  try {
    return new URL(url).origin === new URL(server).origin;
  } catch {
    return false;
  }
};

function createWindow() {
  const state = readSettings().window ?? {};
  win = new BrowserWindow({
    width: state.width ?? 1280,
    height: state.height ?? 840,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Docmore',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    writeSettings({ window: { width, height, x, y } });
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('closed', () => {
    win = null;
  });

  // Links to other sites go to the system browser; ours stay here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOurs(url) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // aborted by a newer navigation
    win.loadFile(path.join(__dirname, 'pick-server.html'), { query: { error: `${description} (${url})` } });
  });

  const server = readSettings().serverUrl;
  if (server) {
    win.loadURL(pendingDeepLink ? toServerUrl(pendingDeepLink) : server);
    pendingDeepLink = null;
  } else {
    win.loadFile(path.join(__dirname, 'pick-server.html'));
  }
}

// docmore://s/space/p/slug -> https://server/s/space/p/slug
function toServerUrl(deepLink) {
  const server = readSettings().serverUrl;
  if (!server) return null;
  const rest = deepLink.replace(/^docmore:\/\//, '');
  return new URL(`/${rest.replace(/^\/+/, '')}`, server).toString();
}

function buildMenu() {
  const nav = (p) => () => {
    const server = readSettings().serverUrl;
    if (server && win) win.loadURL(new URL(p, server).toString());
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: nav('/home') },
        { label: 'AI chat', accelerator: 'CmdOrCtrl+Shift+A', click: nav('/ai') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: nav('/settings/account/profile') },
        { type: 'separator' },
        {
          label: 'Change server…',
          click: () => win && win.loadFile(path.join(__dirname, 'pick-server.html'), { query: { current: readSettings().serverUrl ?? '' } }),
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win && win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win && win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.DOCMORE_DEBUG ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('docmore:set-server', (_e, url) => {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return { ok: false, error: 'Enter the full address, like https://wiki.example.com' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'The address must start with http:// or https://' };
  writeSettings({ serverUrl: parsed.origin });
  if (win) win.loadURL(parsed.origin);
  return { ok: true };
});

ipcMain.on('docmore:notify', (_e, { title, body, url }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Docmore', body: body || '' });
  n.on('click', () => {
    if (win) {
      win.show();
      if (url && isOurs(url)) win.loadURL(url);
    }
  });
  n.show();
});

ipcMain.on('docmore:badge', (_e, count) => {
  if (process.platform === 'darwin') app.dock.setBadge(count > 0 ? String(count) : '');
  else if (win) win.setTitle(count > 0 ? `(${count}) Docmore` : 'Docmore');
});

// One instance; later launches hand their deep link over.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('docmore://'));
    if (link && win) win.loadURL(toServerUrl(link));
    if (win) win.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (win) win.loadURL(toServerUrl(url));
    else pendingDeepLink = url;
  });
  app.setAsDefaultProtocolClient('docmore');
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

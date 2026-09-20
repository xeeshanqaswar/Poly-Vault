'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');

const { JsonStore } = require('./store');
const { startBridge } = require('./bridgeServer');
const { scanLibrary, hashString } = require('./library');

const APP_NAME = 'Poly Vault';
const APP_VERSION = app.getVersion();

let mainWindow = null;
let settings;
let jobsStore;
let tagsStore;
let metaStore;
let bridge;

// Pre-0.3 builds used "Asset Vault" as the product name (and thus the
// userData folder).  First run on the new name carries the old data over.
function migrateUserData() {
  if (process.env.ASSETVAULT_USER_DATA) return;
  const dest = app.getPath('userData');
  if (path.basename(dest).toLowerCase() !== 'poly vault') return;
  const old = path.join(path.dirname(dest), 'Asset Vault');
  if (!fs.existsSync(old) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['asset-vault-settings.json', 'asset-vault-jobs.json', 'asset-vault-tags.json', 'asset-vault-meta.json']) {
      const src = path.join(old, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    console.log('[Poly Vault] migrated user data from', old);
  } catch (err) {
    console.warn('[Poly Vault] user-data migration failed:', err);
  }
}

function getState() {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    libraries: (settings.get('libraries') || []).map((l) =>
      fs.existsSync(l.path) ? l : { ...l, missing: true }
    ),
    jobs: jobsStore.get('jobs') || [],
  };
}

function persistLibraries(libs) {
  settings.set('libraries', libs);
}

function addLibrary(absPath) {
  const libs = settings.get('libraries') || [];
  if (libs.some((l) => path.resolve(l.path) === path.resolve(absPath))) {
    return libs;
  }
  const normalized = path.resolve(absPath);
  const lib = {
    id: `lib_${hashString(normalized)}`,
    name: path.basename(normalized) || normalized,
    path: normalized,
    addedAt: new Date().toISOString(),
  };
  libs.push(lib);
  persistLibraries(libs);
  return libs;
}

function removeLibrary(id) {
  const libs = (settings.get('libraries') || []).filter((l) => l.id !== id);
  persistLibraries(libs);
  return libs;
}

function createWindow() {
  Menu.setApplicationMenu(null); // no File/Edit/View/Window menu bar in a normal desktop app
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#1e1f24',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', '..', 'ui', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.ASSETVAULT_DEBUG) {
    mainWindow.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
  }
}

function registerIpc() {
  ipcMain.handle('assetvault:addLibrary', async () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win) return getState();
    const result = await dialog.showOpenDialog(win, {
      title: 'Add asset library folder',
      properties: ['openDirectory'],
      buttonLabel: 'Add library',
    });
    if (result.canceled || !result.filePaths.length) return getState();
    addLibrary(result.filePaths[0]);
    return getState();
  });

  ipcMain.handle('assetvault:removeLibrary', (_evt, id) => {
    removeLibrary(id);
    return getState();
  });

  ipcMain.handle('assetvault:getState', () => getState());
  ipcMain.handle('assetvault:getServerInfo', () => ({
    host: bridge.host,
    port: bridge.port,
  }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Dev/testing override so a run can be fully headless.
    if (process.env.ASSETVAULT_USER_DATA) {
      app.setPath('userData', process.env.ASSETVAULT_USER_DATA);
    }

    migrateUserData();

    settings = new JsonStore(path.join(app.getPath('userData'), 'asset-vault-settings.json'), {
      libraries: [],
      server: { host: '127.0.0.1', port: 7100 },
    });
    jobsStore = new JsonStore(path.join(app.getPath('userData'), 'asset-vault-jobs.json'), { jobs: [] });
    tagsStore = new JsonStore(path.join(app.getPath('userData'), 'asset-vault-tags.json'), { tags: {} });
    metaStore = new JsonStore(path.join(app.getPath('userData'), 'asset-vault-meta.json'), { meta: {} });

    // Dev/testing hook: register a library at boot without touching the UI.
    if (process.env.ASSETVAULT_BOOT_LIBRARY) {
      addLibrary(process.env.ASSETVAULT_BOOT_LIBRARY);
    }

    const serverCfg = settings.get('server') || { host: '127.0.0.1', port: 7100 };
    bridge = startBridge({
      host: serverCfg.host || '127.0.0.1',
      port: serverCfg.port || 7100,
      getState,
      tags: {
        getAll: () => tagsStore.get('tags') || {},
        set: (targetPath, list) => {
          const all = tagsStore.get('tags') || {};
          const key = path.resolve(targetPath);
          if (!list || list.length === 0) delete all[key];
          else all[key] = list;
          tagsStore.set('tags', all);
          return all[key] || [];
        },
      },
      meta: {
        getAll: () => metaStore.get('meta') || {},
        set: (targetPath, description) => {
          const all = metaStore.get('meta') || {};
          const key = path.resolve(targetPath);
          if (!description) delete all[key];
          else all[key] = { description };
          metaStore.set('meta', all);
          return all[key] ? all[key].description : '';
        },
      },
      onJobsChanged: () => jobsStore.save(),
      onDiag: async (action = '') => {
        if (!mainWindow || mainWindow.isDestroyed()) return { error: 'no window' };
        try {
          let actionJs = '';
          if (action.startsWith('selectRel:')) {
            const rel = action.slice('selectRel:'.length);
            actionJs = `(()=>{const rows=[...document.querySelectorAll('.tree-row')];const r=rows.find(x=>{const n=x.querySelector('.tree-name');return n&&n.textContent===${JSON.stringify(rel)}});if(r)r.click();})();`;
          } else if (action === 'selectFirstCard') {
            actionJs = `(()=>{const c=document.querySelector('.card');if(c)c.click();})();`;
          } else if (action === 'rescan') {
            actionJs = `(()=>{const b=document.getElementById('btn-rescan');if(b)b.click();})();`;
          } else if (action === 'tagpop') {
            actionJs = `(()=>{const p=document.getElementById('tag-popover');if(p)p.classList.remove('hidden');if(window.renderTagPopover)window.renderTagPopover();})();`;
          } else if (action === 'tagpopoff') {
            actionJs = `(()=>{const p=document.getElementById('tag-popover');if(p)p.classList.add('hidden');})();`;
          } else {
            const tagAction = action.match(/^tag:(.+)$/);
            if (tagAction) {
              const name = decodeURIComponent(tagAction[1]);
              actionJs = `toggleTag(${JSON.stringify(name)});`;
            }
            const themeAction = action.match(/^theme:(.+)$/);
            if (themeAction) {
              actionJs = `(()=>{const s=document.getElementById('theme-select');if(s){s.value=${JSON.stringify(themeAction[1])};s.dispatchEvent(new Event('change'));}})();`;
            }
          }
          const raw = await mainWindow.webContents.executeJavaScript(
            `(async()=>{${actionJs};if(${JSON.stringify(Boolean(actionJs))})await new Promise(r=>setTimeout(r,80));return JSON.stringify((()=>{const q=(s)=>document.querySelectorAll(s).length;const dc=document.getElementById('detail-content');return{libs:q('.lib'),treeRows:q('.tree-row'),cards:q('.card'),dot:(document.getElementById('server-dot')||{}).className||'',detail:(document.querySelector('#detail-content h2')||{}).textContent||'',view:(dc?dc.dataset.view:null)||'',metaRows:q('.meta-row'),descEditors:q('.desc-editor'),contTagChips:q('#detail-content .detail-tags.readonly-tags .tag-chip'),theme:document.documentElement.dataset.theme||'',splitters:q('.splitter'),sbW:parseInt(getComputedStyle(document.getElementById('sidebar')).width)||0,trw:[...document.querySelectorAll('.tree-row')].slice(0,8).map(r=>r.style.paddingLeft),rr:window.__pvRenders||0,brandImg:(document.querySelector('.brand-mark')||{}).getAttribute&&(document.querySelector('.brand-mark').getAttribute('src')||'').split('/').pop()||'',brandW:(document.querySelector('.brand-mark')||{}).naturalWidth||0,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),font:getComputedStyle(document.body).fontFamily.split(',')[0].replace(/['"]/g,'').trim(),bg:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color,popRows:q('.pop-row'),cnt:(document.getElementById('filter-count')||{}).textContent||'',unity:(document.getElementById('unity-state')||{}).textContent||'',unityDot:(document.getElementById('unity-dot')||{}).className||''};})())})()`
          );
          return JSON.parse(raw);
        } catch (err) {
          return { error: String((err && err.message) || err) };
        }
      },
    });
    bridge.listen().catch((err) => {
      console.error('Bridge failed to start:', err);
    });

    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      try { bridge.server.close(); } catch (_) { /* ignore */ }
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
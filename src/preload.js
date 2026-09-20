'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assetVault', {
  addLibrary: () => ipcRenderer.invoke('assetvault:addLibrary'),
  removeLibrary: (id) => ipcRenderer.invoke('assetvault:removeLibrary', id),
  getState: () => ipcRenderer.invoke('assetvault:getState'),
  getServerInfo: () => ipcRenderer.invoke('assetvault:getServerInfo'),
});
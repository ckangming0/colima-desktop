const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cli', {
  run: (cmd, args) => ipcRenderer.invoke('run', cmd, args),
  logs: {
    start: (container, opts) => ipcRenderer.send('logs:start', container, opts),
    stop: () => ipcRenderer.send('logs:stop'),
    onData: (fn) => ipcRenderer.on('logs:data', (_e, stream, text) => fn(stream, text)),
    onEnd: (fn) => ipcRenderer.on('logs:end', () => fn()),
  },
});

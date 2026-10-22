const { contextBridge, ipcRenderer } = require('electron');

// 桌面端画中画：主进程创建置顶小窗，前端通过这个桥开关并监听关闭
contextBridge.exposeInMainWorld('pipBridge', {
  supported: true,
  open: () => ipcRenderer.invoke('pip:open'),
  close: () => ipcRenderer.invoke('pip:close'),
  onClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('pip:closed', handler);
    return () => ipcRenderer.removeListener('pip:closed', handler);
  },
});

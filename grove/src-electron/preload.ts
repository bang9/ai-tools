import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("groveElectron", {
  invoke: (cmd: string, args?: Record<string, unknown>) => ipcRenderer.invoke("invoke", cmd, args),
  on: (channel: string, handler: (...args: unknown[]) => void) => {
    const listener = (_event: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});

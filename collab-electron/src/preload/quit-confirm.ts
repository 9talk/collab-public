import { contextBridge, ipcRenderer } from "electron";

// 退出确认小窗：把确认/取消结果回传主进程
contextBridge.exposeInMainWorld("quitConfirm", {
  respond: (confirmed: boolean) =>
    ipcRenderer.send("quit-confirm:response", confirmed),
});

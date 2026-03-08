const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronApi", {
	getMode: () => ipcRenderer.invoke("app:get-mode"),
	getAppConfig: () => ipcRenderer.invoke("app:get-config"),
	getPermanentDeviceId: () => ipcRenderer.invoke("device:get-permanent-id"),
	setFullscreen: (enabled) => ipcRenderer.invoke("window:set-fullscreen", enabled),
	readClipboard: () => ipcRenderer.invoke("clipboard:read"),
	writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
	checkForUpdates: () => ipcRenderer.invoke("updates:check"),
	installUpdateNow: () => ipcRenderer.invoke("updates:install"),
	onUpdateEvent: (handler) => {
		const listener = (_event, payload) => {
			handler(payload);
		};
		ipcRenderer.on("updates:event", listener);
		return () => ipcRenderer.removeListener("updates:event", listener);
	},
});


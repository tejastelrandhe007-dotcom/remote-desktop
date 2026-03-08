const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app, BrowserWindow, Menu, desktopCapturer, session, ipcMain, clipboard, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

app.commandLine.appendSwitch("enable-usermedia-screen-capturing");

let mainWindow;
let currentMode = "host";
let updateCheckTimer = null;

const defaultAppConfig = {
	signalingUrl: "http://YOUR_PUBLIC_SERVER_IP:3000",
	turn: {
		server: "YOUR_TURN_SERVER",
		port: 3478,
		username: "user",
		credential: "password",
	},
};

function getAppConfig() {
	const configPath = path.join(__dirname, "app-config.json");
	try {
		if (fs.existsSync(configPath)) {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
			return {
				signalingUrl: String(parsed.signalingUrl || defaultAppConfig.signalingUrl),
				turn: {
					server: String(parsed.turn && parsed.turn.server ? parsed.turn.server : defaultAppConfig.turn.server),
					port: Number(parsed.turn && parsed.turn.port ? parsed.turn.port : defaultAppConfig.turn.port),
					username: String(parsed.turn && parsed.turn.username ? parsed.turn.username : defaultAppConfig.turn.username),
					credential: String(parsed.turn && parsed.turn.credential ? parsed.turn.credential : defaultAppConfig.turn.credential),
				},
			};
		}
	} catch {
		// Keep defaults when config file cannot be read.
	}

	return defaultAppConfig;
}

function deviceFilePath() {
	return path.join(app.getPath("userData"), "device-registry.json");
}

function getOrCreatePermanentDeviceId() {
	const filePath = deviceFilePath();
	let existing = null;
	try {
		if (fs.existsSync(filePath)) {
			existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
		}
	} catch {
		existing = null;
	}

	if (existing && typeof existing.deviceId === "string" && /^[A-Za-z0-9_-]{6,24}$/.test(existing.deviceId)) {
		return existing.deviceId;
	}

	const generated = `host-${crypto.randomBytes(5).toString("hex")}`;
	fs.writeFileSync(filePath, JSON.stringify({ deviceId: generated, createdAt: new Date().toISOString() }, null, 2), "utf8");
	return generated;
}

function resolveMode() {
	const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
	const modeValue = modeArg ? modeArg.split("=")[1] : "host";
	return modeValue === "viewer" ? "viewer" : "host";
}

function pageForMode(mode) {
	return mode === "viewer" ? "viewer.html" : "host.html";
}

function loadMode(mode) {
	if (!mainWindow) {
		return;
	}

	currentMode = mode === "viewer" ? "viewer" : "host";
	const filePath = path.join(__dirname, "renderer", pageForMode(currentMode));
	mainWindow.loadFile(filePath, { query: { mode: currentMode } });
	mainWindow.setTitle(`Remote Support - ${currentMode === "viewer" ? "Viewer" : "Host"}`);
}

function buildAppMenu() {
	const template = [
		{
			label: "Mode",
			submenu: [
				{ label: "Host", click: () => loadMode("host") },
				{ label: "Viewer", click: () => loadMode("viewer") },
				{ type: "separator" },
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 1000,
		minHeight: 680,
		backgroundColor: "#0b1220",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			nodeIntegration: true,
			contextIsolation: true,
			sandbox: false,
		},
	});

	buildAppMenu();
	loadMode(resolveMode());
}

function registerIpc() {
	ipcMain.handle("app:get-mode", () => currentMode);
	ipcMain.handle("app:get-config", () => getAppConfig());
	ipcMain.handle("device:get-permanent-id", () => getOrCreatePermanentDeviceId());
	ipcMain.handle("window:set-fullscreen", (_event, enabled) => {
		const win = BrowserWindow.getFocusedWindow();
		if (win) {
			win.setFullScreen(Boolean(enabled));
		}
		return Boolean(enabled);
	});
	ipcMain.handle("clipboard:read", () => clipboard.readText());
	ipcMain.handle("clipboard:write", (_event, text) => {
		clipboard.writeText(String(text || ""));
		return true;
	});
	ipcMain.handle("updates:check", async () => {
		if (!app.isPackaged) {
			return { enabled: false, reason: "Updates are disabled in development mode" };
		}
		try {
			await autoUpdater.checkForUpdates();
			return { enabled: true, started: true };
		} catch (error) {
			return { enabled: true, started: false, error: error.message };
		}
	});
	ipcMain.handle("updates:install", () => {
		if (app.isPackaged) {
			autoUpdater.quitAndInstall();
		}
		return true;
	});
}

function setupAutoUpdate() {
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("update-available", () => {
		if (mainWindow) {
			mainWindow.webContents.send("updates:event", { type: "available" });
		}
	});

	autoUpdater.on("update-downloaded", async () => {
		if (!mainWindow) {
			return;
		}
		const result = await dialog.showMessageBox(mainWindow, {
			type: "info",
			title: "Update Ready",
			message: "An update has been downloaded. Restart now to apply it?",
			buttons: ["Restart now", "Later"],
			defaultId: 0,
			cancelId: 1,
		});

		if (result.response === 0) {
			autoUpdater.quitAndInstall();
		}
	});

	autoUpdater.on("error", (error) => {
		if (mainWindow) {
			mainWindow.webContents.send("updates:event", { type: "error", message: error.message });
		}
	});

	autoUpdater.checkForUpdates().catch(() => {});
	updateCheckTimer = setInterval(() => {
		autoUpdater.checkForUpdates().catch(() => {});
	}, 15 * 60 * 1000);
}

app.whenReady().then(() => {
	session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
		try {
			const sources = await desktopCapturer.getSources({
				types: ["screen"],
				thumbnailSize: { width: 0, height: 0 },
			});

			if (!sources.length) {
				callback({});
				return;
			}

			callback({ video: sources[0], audio: "none" });
		} catch {
			callback({});
		}
	});

	registerIpc();
	createWindow();

	if (app.isPackaged) {
		setupAutoUpdate();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

app.on("window-all-closed", () => {
	if (updateCheckTimer) {
		clearInterval(updateCheckTimer);
		updateCheckTimer = null;
	}
	if (process.platform !== "darwin") {
		app.quit();
	}
});

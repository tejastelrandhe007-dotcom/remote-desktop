let ioFactory = null;
try {
	({ io: ioFactory } = require("socket.io-client"));
} catch (_error) {
	if (typeof window !== "undefined" && typeof window.io === "function") {
		ioFactory = window.io;
	}
}

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const syncClipboardBtn = document.getElementById("syncClipboardBtn");
const serverUrlEl = document.getElementById("serverUrl");
const deviceIdEl = document.getElementById("deviceId");
const sessionPasswordEl = document.getElementById("sessionPassword");
const previewEl = document.getElementById("preview");
const approvalPopupEl = document.getElementById("approvalPopup");
const approvalTextEl = document.getElementById("approvalText");
const allowBtn = document.getElementById("allowBtn");
const denyBtn = document.getElementById("denyBtn");

let appConfig = {
	signalingUrl: "http://YOUR_PUBLIC_SERVER_IP:3000",
	turn: {
		server: "YOUR_TURN_SERVER",
		port: 3478,
		username: "user",
		credential: "password",
	},
};

let rtcConfig = {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function rebuildRtcConfigFromAppConfig() {
	rtcConfig = {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{
				urls: `turn:${appConfig.turn.server}:${appConfig.turn.port}`,
				username: appConfig.turn.username,
				credential: appConfig.turn.credential,
			},
		],
	};
}

const SERVER_URL_KEY = "remoteSupport.serverUrl";
const HOST_MODE_KEY = "remoteSupport.hostMode";

let socket = null;
let localStream = null;
let activeDeviceId = "";
let sessionPassword = "";
let hostMode = localStorage.getItem(HOST_MODE_KEY) === "multi" ? "multi" : "single";
let pendingApproval = null;
let robot = null;
let modeSelectEl = null;
let connectedViewerCount = 0;

const peers = new Map(); // viewerSocketId -> { pc, pendingIceCandidates, dataChannel, bitrateTimer }

try {
	robot = require("robotjs");
} catch (_error) {
	robot = null;
}

function setStatus(message) {
	const modeNote = hostMode === "multi" ? "multi-view mode" : "single-view mode";
	statusEl.textContent = `Status: ${message} (${modeNote}, viewers: ${connectedViewerCount})`;
}

function randomPassword(length = 4) {
	const alphabet = "0123456789";
	let output = "";
	for (let i = 0; i < length; i += 1) {
		output += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return output;
}

function defaultServerUrl() {
	const fromQuery = new URLSearchParams(window.location.search).get("server");
	if (fromQuery) {
		return fromQuery;
	}
	const stored = localStorage.getItem(SERVER_URL_KEY);
	if (stored) {
		return stored;
	}
	if (window.location.protocol === "http:" || window.location.protocol === "https:") {
		return window.location.origin;
	}
	return appConfig.signalingUrl || "http://localhost:3000";
}
async function initializeConfig() {
	if (window.electronApi && typeof window.electronApi.getAppConfig === "function") {
		try {
			const cfg = await window.electronApi.getAppConfig();
			if (cfg && typeof cfg === "object") {
				appConfig = {
					signalingUrl: String(cfg.signalingUrl || appConfig.signalingUrl),
					turn: {
						server: String(cfg.turn && cfg.turn.server ? cfg.turn.server : appConfig.turn.server),
						port: Number(cfg.turn && cfg.turn.port ? cfg.turn.port : appConfig.turn.port),
						username: String(cfg.turn && cfg.turn.username ? cfg.turn.username : appConfig.turn.username),
						credential: String(cfg.turn && cfg.turn.credential ? cfg.turn.credential : appConfig.turn.credential),
					},
				};
			}
		} catch {
			// Keep fallback defaults when config is unavailable.
		}
	}

	rebuildRtcConfigFromAppConfig();
	if (!serverUrlEl.value.trim()) {
		serverUrlEl.value = defaultServerUrl();
	}
}


function saveServerUrl(url) {
	if (url) {
		localStorage.setItem(SERVER_URL_KEY, url);
	}
}

function createHostModeControl() {
	const container = document.createElement("div");
	container.className = "field";
	container.style.minWidth = "220px";
	container.innerHTML = `
		<label for="hostModeSelect">Viewer Mode</label>
		<select id="hostModeSelect" style="height:42px;border-radius:10px;border:1px solid #cbd5e1;padding:0 10px;font-weight:600;">
			<option value="single">Single Viewer</option>
			<option value="multi">Multi Viewer (watch + one control)</option>
		</select>
	`;
	const cardRow = document.querySelector(".control-card .row");
	if (cardRow) {
		cardRow.prepend(container);
		modeSelectEl = document.getElementById("hostModeSelect");
		modeSelectEl.value = hostMode;
		modeSelectEl.addEventListener("change", () => {
			hostMode = modeSelectEl.value === "multi" ? "multi" : "single";
			localStorage.setItem(HOST_MODE_KEY, hostMode);
			setStatus("mode updated");
			if (socket && socket.connected && activeDeviceId && sessionPassword) {
				socket.emit("register-host", {
					deviceId: activeDeviceId,
					password: sessionPassword,
					mode: hostMode,
				});
			}
		});
	}
}

async function captureScreen() {
	return navigator.mediaDevices.getDisplayMedia({
		audio: false,
		video: {
			width: { ideal: 1280, max: 1280 },
			height: { ideal: 720, max: 720 },
			frameRate: { ideal: 20, max: 20 },
		},
	});
}

function setPreferredCodec(pc) {
	if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) {
		return;
	}
	const capabilities = RTCRtpSender.getCapabilities("video");
	if (!capabilities || !Array.isArray(capabilities.codecs)) {
		return;
	}
	const preferred = capabilities.codecs.find((codec) => codec.mimeType.toLowerCase() === "video/h264") || capabilities.codecs.find((codec) => codec.mimeType.toLowerCase() === "video/vp9");
	if (!preferred) {
		return;
	}
	const transceiver = pc.getTransceivers().find((item) => item.sender && item.sender.track && item.sender.track.kind === "video");
	if (!transceiver || !transceiver.setCodecPreferences) {
		return;
	}
	const ordered = [preferred, ...capabilities.codecs.filter((codec) => codec !== preferred)];
	transceiver.setCodecPreferences(ordered);
}

function startAdaptiveBitrate(peerState) {
	const sender = peerState.pc.getSenders().find((item) => item.track && item.track.kind === "video");
	if (!sender) {
		return;
	}
	let targetBitrate = 1_800_000;
	let lastBytes = 0;
	let lastTs = 0;
	peerState.bitrateTimer = setInterval(async () => {
		try {
			const stats = await peerState.pc.getStats(sender);
			stats.forEach((report) => {
				if (report.type !== "outbound-rtp" || report.kind !== "video") {
					return;
				}
				if (lastTs) {
					const bitsPerSecond = ((report.bytesSent - lastBytes) * 8) / ((report.timestamp - lastTs) / 1000);
					if (bitsPerSecond < 700_000) {
						targetBitrate = Math.max(600_000, targetBitrate - 150_000);
					} else if (bitsPerSecond > 1_500_000) {
						targetBitrate = Math.min(3_000_000, targetBitrate + 150_000);
					}
					const params = sender.getParameters();
					if (!params.encodings || !params.encodings.length) {
						params.encodings = [{}];
					}
					params.encodings[0].maxBitrate = targetBitrate;
					sender.setParameters(params).catch(() => {});
				}
				lastBytes = report.bytesSent;
				lastTs = report.timestamp;
			});
		} catch {
			// Ignore stats failures.
		}
	}, 5000);
}

function stopPeer(viewerSocketId) {
	const peerState = peers.get(viewerSocketId);
	if (!peerState) {
		return;
	}
	if (peerState.bitrateTimer) {
		clearInterval(peerState.bitrateTimer);
	}
	peerState.pc.close();
	peers.delete(viewerSocketId);
	connectedViewerCount = peers.size;
	syncClipboardBtn.disabled = peers.size === 0;
	disconnectBtn.disabled = peers.size === 0;
}

function stopAllPeers() {
	for (const viewerSocketId of peers.keys()) {
		stopPeer(viewerSocketId);
	}
	connectedViewerCount = 0;
	syncClipboardBtn.disabled = true;
	disconnectBtn.disabled = true;
}

function toRobotMouseButton(button) {
	if (button === 2) return "right";
	if (button === 1) return "middle";
	return "left";
}

function toRobotKey(key) {
	const specialMap = {
		Control: "control",
		Alt: "alt",
		Shift: "shift",
		Meta: "command",
		Enter: "enter",
		Escape: "escape",
		Backspace: "backspace",
		Tab: "tab",
		ArrowUp: "up",
		ArrowDown: "down",
		ArrowLeft: "left",
		ArrowRight: "right",
		Delete: "delete",
		Home: "home",
		End: "end",
		PageUp: "pageup",
		PageDown: "pagedown",
		" ": "space",
	};
	if (specialMap[key]) return specialMap[key];
	if (/^F\d{1,2}$/.test(key)) return key.toLowerCase();
	if (/^[a-zA-Z0-9]$/.test(key)) return key.toLowerCase();
	return null;
}

function executeRemoteInput(inputEvent) {
	if (!robot) {
		return;
	}
	const screen = robot.getScreenSize();
	switch (inputEvent.type) {
		case "mouse-move": {
			const xRatio = Math.max(0, Math.min(1, Number(inputEvent.xRatio) || 0));
			const yRatio = Math.max(0, Math.min(1, Number(inputEvent.yRatio) || 0));
			robot.moveMouseSmooth(Math.round(xRatio * (screen.width - 1)), Math.round(yRatio * (screen.height - 1)));
			break;
		}
		case "mouse-down":
		case "mouse-up": {
			const action = inputEvent.type === "mouse-down" ? "down" : "up";
			robot.mouseToggle(action, toRobotMouseButton(Number(inputEvent.button) || 0));
			break;
		}
		case "mouse-wheel":
			robot.scrollMouse(Number(inputEvent.deltaX) || 0, Number(inputEvent.deltaY) || 0);
			break;
		case "key-down":
		case "key-up": {
			const action = inputEvent.type === "key-down" ? "down" : "up";
			const key = toRobotKey(inputEvent.key);
			if (key) {
				robot.keyToggle(key, action);
			}
			break;
		}
		default:
			break;
	}
}

function hideApprovalPopup() {
	approvalPopupEl.classList.add("hidden");
	pendingApproval = null;
}

function showApprovalPopup(data) {
	pendingApproval = data;
	approvalTextEl.textContent = `Viewer ${data.viewerSocketId.slice(0, 8)} (${data.viewerIp || "unknown IP"}) requests connection. Allow or deny?`;
	approvalPopupEl.classList.remove("hidden");
}

function handleDataChannelMessage(event) {
	let parsed;
	try {
		parsed = JSON.parse(event.data);
	} catch {
		return;
	}
	if (parsed.type === "clipboard" && window.electronApi) {
		window.electronApi.writeClipboard(parsed.text || "").catch(() => {});
	}
}

function createPeerForViewer(viewerSocketId) {
	stopPeer(viewerSocketId);

	const pc = new RTCPeerConnection(rtcConfig);
	const peerState = {
		pc,
		pendingIceCandidates: [],
		dataChannel: null,
		bitrateTimer: null,
	};
	peers.set(viewerSocketId, peerState);

	for (const track of localStream.getTracks()) {
		pc.addTrack(track, localStream);
	}

	setPreferredCodec(pc);
	startAdaptiveBitrate(peerState);

	peerState.dataChannel = pc.createDataChannel("support-data", { ordered: true });
	peerState.dataChannel.onmessage = handleDataChannelMessage;
	peerState.dataChannel.onopen = () => {
		syncClipboardBtn.disabled = false;
	};

	pc.onicecandidate = (event) => {
		if (!event.candidate || !socket || !activeDeviceId) {
			return;
		}
		socket.emit("ice-candidate", {
			deviceId: activeDeviceId,
			toViewerSocketId: viewerSocketId,
			candidate: event.candidate,
		});
	};

	pc.onconnectionstatechange = () => {
		const state = pc.connectionState;
		if (state === "connected") {
			socket.emit("session-connected", { deviceId: activeDeviceId });
			connectedViewerCount = peers.size;
			disconnectBtn.disabled = false;
			syncClipboardBtn.disabled = false;
			setStatus("displaying remote screen");
			return;
		}
		if (["failed", "disconnected", "closed"].includes(state)) {
			setStatus(`viewer ${viewerSocketId.slice(0, 6)} ${state}`);
		}
	};

	return peerState;
}

async function flushPendingIceCandidates(peerState) {
	if (!peerState || !peerState.pc.remoteDescription) {
		return;
	}
	while (peerState.pendingIceCandidates.length > 0) {
		const candidate = peerState.pendingIceCandidates.shift();
		try {
			await peerState.pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch {
			// Ignore stale candidates.
		}
	}
}

async function createOfferForViewer(viewerSocketId) {
	const peerState = createPeerForViewer(viewerSocketId);
	const offer = await peerState.pc.createOffer();
	await peerState.pc.setLocalDescription(offer);
	socket.emit("offer", {
		deviceId: activeDeviceId,
		toViewerSocketId: viewerSocketId,
		offer,
	});
	setStatus(`offer sent to viewer ${viewerSocketId.slice(0, 6)}`);
}

function connectSocket(serverUrl) {
	if (!ioFactory) {
		setStatus("socket.io client is unavailable");
		return;
	}
	saveServerUrl(serverUrl);
	socket = ioFactory(serverUrl, {
		timeout: 8000,
		reconnection: true,
		reconnectionAttempts: Infinity,
		reconnectionDelayMax: 7000,
		transports: ["websocket", "polling"],
	});

	socket.on("connect", () => {
		socket.emit("register-host", {
			deviceId: activeDeviceId,
			password: sessionPassword,
			mode: hostMode,
		});
		setStatus("registering host");
	});

	socket.on("host-registered", ({ deviceId, mode }) => {
		activeDeviceId = String(deviceId);
		deviceIdEl.value = activeDeviceId;
		hostMode = mode === "multi" ? "multi" : "single";
		if (modeSelectEl) {
			modeSelectEl.value = hostMode;
		}
		setStatus("host registered, waiting for viewer");
	});

	socket.on("connection-request", (payload) => {
		showApprovalPopup(payload);
		setStatus("viewer requested connection");
	});

	socket.on("viewer-approved", async ({ viewerSocketId }) => {
		connectedViewerCount += 1;
		disconnectBtn.disabled = false;
		try {
			await createOfferForViewer(String(viewerSocketId));
		} catch (error) {
			setStatus(`offer failed: ${error.message}`);
		}
	});

	socket.on("viewer-resumed", async ({ viewerSocketId }) => {
		try {
			await createOfferForViewer(String(viewerSocketId));
			setStatus("viewer resumed session");
		} catch (error) {
			setStatus(`resume failed: ${error.message}`);
		}
	});

	socket.on("answer", async ({ from, answer }) => {
		const viewerSocketId = String(from || "");
		const peerState = peers.get(viewerSocketId);
		if (!peerState) {
			return;
		}
		await peerState.pc.setRemoteDescription(new RTCSessionDescription(answer));
		await flushPendingIceCandidates(peerState);
		setStatus("displaying remote screen");
	});

	socket.on("ice-candidate", async ({ from, candidate }) => {
		const viewerSocketId = String(from || "");
		const peerState = peers.get(viewerSocketId);
		if (!peerState || !candidate) {
			return;
		}
		if (!peerState.pc.remoteDescription) {
			peerState.pendingIceCandidates.push(candidate);
			return;
		}
		try {
			await peerState.pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch {
			// Ignore stale candidates.
		}
	});

	socket.on("remote-input", ({ event }) => {
		if (event) {
			executeRemoteInput(event);
		}
	});

	socket.on("control-request", ({ requestId, viewerSocketId }) => {
		const accepted = window.confirm(`Viewer ${String(viewerSocketId).slice(0, 8)} requests control. Allow control transfer?`);
		socket.emit("host-control-response", { requestId, allow: accepted });
		setStatus(accepted ? "control transfer approved" : "control transfer denied");
	});

	socket.on("viewer-clipboard", ({ text }) => {
		if (window.electronApi) {
			window.electronApi.writeClipboard(String(text || "")).catch(() => {});
		}
	});

	socket.on("peer-disconnected", ({ viewerSocketId, reason }) => {
		if (viewerSocketId) {
			stopPeer(String(viewerSocketId));
		}
		connectedViewerCount = peers.size;
		setStatus(reason || "viewer disconnected");
	});

	socket.on("connection-denied", ({ reason }) => {
		setStatus(reason || "connection denied");
		hideApprovalPopup();
	});

	socket.on("disconnect", (reason) => {
		stopAllPeers();
		setStatus(`signaling disconnected: ${reason}`);
	});

	socket.on("error-message", (message) => {
		setStatus(String(message || "server error"));
	});
}

startBtn.addEventListener("click", async () => {
	const serverUrl = serverUrlEl.value.trim();
	if (!serverUrl) {
		setStatus("enter signaling server URL");
		return;
	}

	startBtn.disabled = true;
	try {
		if (!activeDeviceId && window.electronApi && window.electronApi.getPermanentDeviceId) {
			activeDeviceId = await window.electronApi.getPermanentDeviceId();
			deviceIdEl.value = activeDeviceId;
		}
		if (!activeDeviceId) {
			const fallback = localStorage.getItem("remoteSupport.fallbackDeviceId") || `host-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem("remoteSupport.fallbackDeviceId", fallback);
			activeDeviceId = fallback;
			deviceIdEl.value = activeDeviceId;
		}
		if (!sessionPassword) {
			sessionPassword = randomPassword();
			sessionPasswordEl.value = sessionPassword;
		}
		if (!localStream) {
			setStatus("capturing screen");
			localStream = await captureScreen();
			previewEl.srcObject = localStream;
		}
		if (!socket) {
			connectSocket(serverUrl);
		} else if (socket.connected) {
			socket.emit("register-host", {
				deviceId: activeDeviceId,
				password: sessionPassword,
				mode: hostMode,
			});
		}
	} catch (error) {
		setStatus(`failed: ${error.message}`);
	} finally {
		startBtn.disabled = false;
	}
});

disconnectBtn.addEventListener("click", () => {
	if (socket && socket.connected && activeDeviceId) {
		socket.emit("host-disconnect-session", { deviceId: activeDeviceId });
	}
	stopAllPeers();
	setStatus("session disconnected");
});

syncClipboardBtn.addEventListener("click", async () => {
	if (!socket || !socket.connected || !activeDeviceId || !window.electronApi) {
		return;
	}
	const text = await window.electronApi.readClipboard();
	socket.emit("host-clipboard", { deviceId: activeDeviceId, text });
	for (const peerState of peers.values()) {
		if (peerState.dataChannel && peerState.dataChannel.readyState === "open") {
			peerState.dataChannel.send(JSON.stringify({ type: "clipboard", text }));
		}
	}
	setStatus("clipboard synced to viewers");
});

allowBtn.addEventListener("click", () => {
	if (!pendingApproval || !socket) {
		return;
	}
	socket.emit("host-connection-response", {
		requestId: pendingApproval.requestId,
		allow: true,
	});
	hideApprovalPopup();
	setStatus("approval sent");
});

denyBtn.addEventListener("click", () => {
	if (!pendingApproval || !socket) {
		return;
	}
	socket.emit("host-connection-response", {
		requestId: pendingApproval.requestId,
		allow: false,
	});
	hideApprovalPopup();
	setStatus("connection denied");
});

serverUrlEl.value = defaultServerUrl();
createHostModeControl();
setStatus("idle");
initializeConfig();

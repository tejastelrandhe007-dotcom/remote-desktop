let ioFactory = null;
try {
	({ io: ioFactory } = require("socket.io-client"));
} catch (_error) {
	if (typeof window !== "undefined" && typeof window.io === "function") {
		ioFactory = window.io;
	}
}

const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connectBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const clipboardBtn = document.getElementById("clipboardBtn");
const deviceIdEl = document.getElementById("deviceId");
const passwordEl = document.getElementById("password");
const serverUrlEl = document.getElementById("serverUrl");
const fileInputEl = document.getElementById("fileInput");
const remoteVideoEl = document.getElementById("remoteVideo");

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
const RESUME_KEY_PREFIX = "remoteSupport.resumeToken.";

let socket = null;
let peerConnection = null;
let dataChannel = null;
let hostSocketId = "";
let activeDeviceId = "";
let activePassword = "";
let pendingIceCandidates = [];
let pendingMouse = null;
let mouseFlushScheduled = false;
let reconnectTimer = null;
let shouldReconnect = false;
let isFullscreen = false;
let canControl = false;
let controlRequestBtn = null;
let fileBuffer = [];
let fileName = "";

function setStatus(message) {
	const controlState = canControl ? "control enabled" : "watch-only";
	statusEl.textContent = `Status: ${message} (${controlState})`;
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

function getResumeToken(deviceId) {
	return localStorage.getItem(`${RESUME_KEY_PREFIX}${deviceId}`) || "";
}

function setResumeToken(deviceId, token) {
	if (!deviceId) {
		return;
	}
	if (!token) {
		localStorage.removeItem(`${RESUME_KEY_PREFIX}${deviceId}`);
		return;
	}
	localStorage.setItem(`${RESUME_KEY_PREFIX}${deviceId}`, token);
}

function clearReconnectTimer() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

function scheduleReconnect() {
	if (!shouldReconnect || reconnectTimer) {
		return;
	}
	setStatus("connection dropped, retrying...");
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		startConnection(true);
	}, 2500);
}

function emitConnectionState(state) {
	if (socket && socket.connected && activeDeviceId) {
		socket.emit("connection-state", { deviceId: activeDeviceId, state });
	}
}

function teardownPeer() {
	if (peerConnection) {
		peerConnection.close();
		peerConnection = null;
	}
	dataChannel = null;
	pendingIceCandidates = [];
	remoteVideoEl.srcObject = null;
	clipboardBtn.disabled = true;
	disconnectBtn.disabled = true;
}

async function flushPendingIce() {
	if (!peerConnection || !peerConnection.remoteDescription) {
		return;
	}
	while (pendingIceCandidates.length > 0) {
		const candidate = pendingIceCandidates.shift();
		try {
			await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch {
			// Ignore stale candidates.
		}
	}
}

function setupDataChannel(channel) {
	dataChannel = channel;
	dataChannel.onopen = () => {
		clipboardBtn.disabled = false;
	};
	dataChannel.onclose = () => {
		clipboardBtn.disabled = true;
	};
	dataChannel.onmessage = async (event) => {
		let parsed;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return;
		}

		if (parsed.type === "clipboard" && window.electronApi) {
			await window.electronApi.writeClipboard(parsed.text || "");
			setStatus("clipboard received from host");
		}

		if (parsed.type === "file-meta") {
			fileName = parsed.name || "remote.bin";
			fileBuffer = [];
		}

		if (parsed.type === "file-chunk") {
			fileBuffer.push(parsed.chunk || "");
		}

		if (parsed.type === "file-end") {
			const binary = atob(fileBuffer.join(""));
			const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
			const blob = new Blob([bytes]);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(blob);
			link.download = fileName;
			link.click();
			URL.revokeObjectURL(link.href);
			fileBuffer = [];
			fileName = "";
			setStatus("file received");
		}
	};
}

function ensurePeerConnection() {
	if (peerConnection) {
		return peerConnection;
	}

	peerConnection = new RTCPeerConnection(rtcConfig);

	peerConnection.ontrack = (event) => {
		if (event.streams && event.streams[0]) {
			remoteVideoEl.srcObject = event.streams[0];
			setStatus("displaying remote screen");
		}
	};

	peerConnection.ondatachannel = (event) => {
		setupDataChannel(event.channel);
	};

	peerConnection.onicecandidate = (event) => {
		if (!event.candidate || !socket || !activeDeviceId) {
			return;
		}
		socket.emit("ice-candidate", {
			deviceId: activeDeviceId,
			candidate: event.candidate,
		});
	};

	peerConnection.onconnectionstatechange = () => {
		const state = peerConnection.connectionState;
		emitConnectionState(state);
		if (state === "connected") {
			socket.emit("session-connected", { deviceId: activeDeviceId });
			setStatus("displaying remote screen");
			disconnectBtn.disabled = false;
			clipboardBtn.disabled = false;
			return;
		}
		if (["failed", "disconnected", "closed"].includes(state)) {
			setStatus(`connection ${state}`);
			scheduleReconnect();
		}
	};

	return peerConnection;
}

function emitRemoteInput(eventPayload) {
	if (!canControl) {
		return;
	}
	if (!socket || !socket.connected || !activeDeviceId) {
		return;
	}
	socket.emit("remote-input", {
		deviceId: activeDeviceId,
		event: eventPayload,
	});
}

function getMouseRatio(event) {
	const rect = remoteVideoEl.getBoundingClientRect();
	if (!rect.width || !rect.height) {
		return { xRatio: 0, yRatio: 0 };
	}
	return {
		xRatio: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
		yRatio: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
	};
}

function queueMouseMove(event) {
	pendingMouse = getMouseRatio(event);
	if (mouseFlushScheduled) {
		return;
	}
	mouseFlushScheduled = true;
	setTimeout(() => {
		mouseFlushScheduled = false;
		if (!pendingMouse) {
			return;
		}
		emitRemoteInput({ type: "mouse-move", ...pendingMouse });
		pendingMouse = null;
	}, 16);
}

async function handleOffer({ offer }) {
	const pc = ensurePeerConnection();
	await pc.setRemoteDescription(new RTCSessionDescription(offer));
	await flushPendingIce();
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);
	socket.emit("answer", { deviceId: activeDeviceId, answer });
	setStatus("connecting to host");
}

async function checkDeviceOnline(serverUrl, deviceId) {
	try {
		const response = await fetch(`${serverUrl.replace(/\/$/, "")}/hosts/${encodeURIComponent(deviceId)}/status`);
		if (!response.ok) {
			return null;
		}
		return await response.json();
	} catch {
		return null;
	}
}

function bindSocket(serverUrl, isResumeAttempt) {
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
		setStatus("connecting to host");
		socket.emit("request-viewer-connection", {
			deviceId: activeDeviceId,
			password: activePassword,
			resumeToken: getResumeToken(activeDeviceId),
		});
		if (isResumeAttempt) {
			setStatus("attempting to resume session");
		}
	});

	socket.on("approval-pending", () => {
		setStatus("waiting for host approval");
	});

	socket.on("viewer-approved", ({ hostSocketId: nextHostSocketId, deviceId, resumeToken, canControl: nextCanControl, resumed }) => {
		hostSocketId = String(nextHostSocketId || "");
		activeDeviceId = String(deviceId || activeDeviceId);
		canControl = Boolean(nextCanControl);
		setResumeToken(activeDeviceId, String(resumeToken || ""));
		ensurePeerConnection();
		setStatus(resumed ? "session resumed, waiting for stream" : "connecting to host");
	});

	socket.on("control-state", ({ canControl: stateCanControl, reason }) => {
		canControl = Boolean(stateCanControl);
		setStatus(canControl ? "control enabled" : `watch-only${reason ? `: ${reason}` : ""}`);
	});

	socket.on("offer", async (payload) => {
		try {
			await handleOffer(payload);
		} catch (error) {
			setStatus(`offer handling failed: ${error.message}`);
		}
	});

	socket.on("ice-candidate", async ({ candidate }) => {
		if (!peerConnection || !candidate) {
			return;
		}
		if (!peerConnection.remoteDescription) {
			pendingIceCandidates.push(candidate);
			return;
		}
		try {
			await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch {
			// Ignore stale candidates.
		}
	});

	socket.on("host-clipboard", async ({ text }) => {
		if (window.electronApi) {
			await window.electronApi.writeClipboard(String(text || ""));
			setStatus("clipboard received from host");
		}
	});

	socket.on("connection-state", ({ state }) => {
		if (state) {
			setStatus(`host connection ${state}`);
		}
	});

	socket.on("connection-denied", ({ reason }) => {
		setStatus(reason || "connection denied by host");
		teardownPeer();
		hostSocketId = "";
	});

	socket.on("peer-disconnected", ({ reason, recoverable }) => {
		setStatus(reason || "host disconnected");
		teardownPeer();
		hostSocketId = "";
		if (recoverable !== false) {
			scheduleReconnect();
		}
	});

	socket.on("disconnect", () => {
		teardownPeer();
		hostSocketId = "";
		scheduleReconnect();
	});

	socket.on("error-message", (message) => {
		setStatus(String(message || "server error"));
	});
}

async function startConnection(isResumeAttempt = false) {
	const serverUrl = serverUrlEl.value.trim();
	const deviceId = deviceIdEl.value.trim();
	const password = passwordEl.value.trim();

	if (!serverUrl) {
		setStatus("enter signaling server URL");
		return;
	}
	if (!/^[A-Za-z0-9_-]{6,24}$/.test(deviceId)) {
		setStatus("enter a valid device ID");
		return;
	}
	if (!password) {
		setStatus("enter temporary password");
		return;
	}
	if (!/^\d{4}$/.test(password)) {
		setStatus("temporary password must be exactly 4 digits");
		return;
	}

	const availability = await checkDeviceOnline(serverUrl, deviceId);
	if (availability && availability.status === "offline" && !isResumeAttempt) {
		setStatus("target device is currently offline");
		return;
	}

	activeDeviceId = deviceId;
	activePassword = password;
	shouldReconnect = true;
	clearReconnectTimer();

	if (socket) {
		socket.disconnect();
		socket = null;
	}

	teardownPeer();
	hostSocketId = "";
	bindSocket(serverUrl, isResumeAttempt);
	setStatus(isResumeAttempt ? "resuming session" : "connecting to host");
}

function disconnectSession() {
	shouldReconnect = false;
	clearReconnectTimer();
	if (socket && socket.connected && activeDeviceId) {
		socket.emit("viewer-disconnect-session", { deviceId: activeDeviceId });
	}
	if (socket) {
		socket.disconnect();
		socket = null;
	}
	teardownPeer();
	hostSocketId = "";
	canControl = false;
	setStatus("disconnected");
}

connectBtn.addEventListener("click", () => {
	startConnection(false);
});

disconnectBtn.addEventListener("click", () => {
	disconnectSession();
});

fullscreenBtn.addEventListener("click", async () => {
	isFullscreen = !isFullscreen;
	if (window.electronApi) {
		await window.electronApi.setFullscreen(isFullscreen);
	}
	fullscreenBtn.textContent = isFullscreen ? "Exit Fullscreen" : "Fullscreen";
});

clipboardBtn.addEventListener("click", async () => {
	if (!socket || !socket.connected || !activeDeviceId || !window.electronApi) {
		return;
	}
	const text = await window.electronApi.readClipboard();
	socket.emit("viewer-clipboard", { deviceId: activeDeviceId, text });
	if (dataChannel && dataChannel.readyState === "open") {
		dataChannel.send(JSON.stringify({ type: "clipboard", text }));
	}
	setStatus("clipboard synced to host");
});

fileInputEl.addEventListener("change", async (event) => {
	const file = event.target.files && event.target.files[0];
	if (!file || !dataChannel || dataChannel.readyState !== "open") {
		return;
	}

	const buffer = await file.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	const chunkSize = 16_000;

	dataChannel.send(JSON.stringify({ type: "file-meta", name: file.name, size: file.size }));
	for (let i = 0; i < base64.length; i += chunkSize) {
		dataChannel.send(JSON.stringify({ type: "file-chunk", chunk: base64.slice(i, i + chunkSize) }));
	}
	dataChannel.send(JSON.stringify({ type: "file-end" }));
	setStatus("file sent to host");
	fileInputEl.value = "";
});

remoteVideoEl.addEventListener("mousemove", (event) => {
	if (!remoteVideoEl.srcObject) {
		return;
	}
	queueMouseMove(event);
});

remoteVideoEl.addEventListener("mousedown", (event) => {
	if (!remoteVideoEl.srcObject || !canControl) {
		return;
	}
	remoteVideoEl.focus();
	const pos = getMouseRatio(event);
	emitRemoteInput({ type: "mouse-move", ...pos });
	emitRemoteInput({ type: "mouse-down", button: event.button });
	event.preventDefault();
});

remoteVideoEl.addEventListener("mouseup", (event) => {
	if (!remoteVideoEl.srcObject || !canControl) {
		return;
	}
	emitRemoteInput({ type: "mouse-up", button: event.button });
	event.preventDefault();
});

remoteVideoEl.addEventListener("wheel", (event) => {
	if (!remoteVideoEl.srcObject || !canControl) {
		return;
	}
	emitRemoteInput({
		type: "mouse-wheel",
		deltaX: Math.round(event.deltaX),
		deltaY: Math.round(event.deltaY),
	});
	event.preventDefault();
});

remoteVideoEl.addEventListener("contextmenu", (event) => {
	event.preventDefault();
});

window.addEventListener("keydown", (event) => {
	if (!remoteVideoEl.srcObject || !canControl) {
		return;
	}
	if (document.activeElement && document.activeElement.tagName === "INPUT") {
		return;
	}
	emitRemoteInput({ type: "key-down", key: event.key });
	event.preventDefault();
});

window.addEventListener("keyup", (event) => {
	if (!remoteVideoEl.srcObject || !canControl) {
		return;
	}
	if (document.activeElement && document.activeElement.tagName === "INPUT") {
		return;
	}
	emitRemoteInput({ type: "key-up", key: event.key });
	event.preventDefault();
});

function createControlRequestButton() {
	const row = document.querySelector(".control-card .row");
	if (!row) {
		return;
	}
	controlRequestBtn = document.createElement("button");
	controlRequestBtn.type = "button";
	controlRequestBtn.className = "secondary";
	controlRequestBtn.textContent = "Request Control";
	controlRequestBtn.addEventListener("click", () => {
		if (!socket || !socket.connected || !activeDeviceId) {
			return;
		}
		socket.emit("request-control", { deviceId: activeDeviceId });
		setStatus("control request sent to host");
	});
	row.appendChild(controlRequestBtn);
}

serverUrlEl.value = defaultServerUrl();
createControlRequestButton();
setStatus("idle");
initializeConfig();

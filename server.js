const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
	},
	pingInterval: 10_000,
	pingTimeout: 20_000,
});

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_GRACE_MS = 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const SOCKET_WINDOW_MS = 60_000;
const SOCKET_WINDOW_MAX = 90;
const VIEWER_CONNECT_LIMIT = 20;

const DATA_DIR = path.join(__dirname, "data");
const REGISTRY_FILE = path.join(DATA_DIR, "device-registry.json");
const LOGS_FILE = path.join(DATA_DIR, "session-logs.json");
const DASHBOARD_FILE = path.join(__dirname, "admin-dashboard.html");
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST_PAGE_FILE = path.join(__dirname, "host.html");
const VIEWER_PAGE_FILE = path.join(__dirname, "viewer.html");
const LEGACY_RENDERER_FILE = path.join(__dirname, "renderer.js");
const DIST_DIR = path.join(__dirname, "dist");

const hostsBySocketId = new Map(); // hostSocketId -> { deviceId, passwordHash, passwordSalt, mode }
const hostSocketByDeviceId = new Map(); // deviceId -> hostSocketId
const pendingRequests = new Map(); // requestId -> request payload
const sessionsByHostSocketId = new Map(); // hostSocketId -> session
const viewerSocketIndex = new Map(); // viewerSocketId -> { hostSocketId, deviceId, resumeToken }
const controlRequests = new Map(); // controlRequestId -> { hostSocketId, viewerSocketId, timer }
const viewerRateLimitByIp = new Map(); // ip -> { count, resetAt }
const socketRateLimitByIp = new Map(); // ip -> { count, resetAt }

const deviceRegistry = readJsonSafe(REGISTRY_FILE, {});
const sessionLogs = readJsonSafe(LOGS_FILE, []);
const activeLogByResumeToken = new Map();

function ensureDataFiles() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
	if (!fs.existsSync(REGISTRY_FILE)) {
		writeJsonSafe(REGISTRY_FILE, deviceRegistry);
	}
	if (!fs.existsSync(LOGS_FILE)) {
		writeJsonSafe(LOGS_FILE, sessionLogs);
	}
}

function readJsonSafe(filePath, fallback) {
	try {
		if (!fs.existsSync(filePath)) {
			return fallback;
		}
		const raw = fs.readFileSync(filePath, "utf8");
		if (!raw.trim()) {
			return fallback;
		}
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function writeJsonSafe(filePath, value) {
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function nowIso() {
	return new Date().toISOString();
}

function getClientIp(socket) {
	const xff = socket.handshake.headers["x-forwarded-for"];
	if (typeof xff === "string" && xff.trim()) {
		return xff.split(",")[0].trim();
	}
	return socket.handshake.address || "unknown";
}

function randomId(prefix) {
	return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function hashPassword(password, salt) {
	return crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
}

function secureEqual(a, b) {
	const aa = Buffer.from(String(a || ""));
	const bb = Buffer.from(String(b || ""));
	if (aa.length !== bb.length) {
		return false;
	}
	return crypto.timingSafeEqual(aa, bb);
}

function canPassWindowLimit(map, key, maxCount, windowMs) {
	const now = Date.now();
	const current = map.get(key);
	if (!current || current.resetAt <= now) {
		map.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	if (current.count >= maxCount) {
		return false;
	}
	current.count += 1;
	return true;
}

function updateDeviceStatus(deviceId) {
	const hostSocketId = hostSocketByDeviceId.get(deviceId);
	let status = "offline";
	if (hostSocketId) {
		status = "online";
		const session = sessionsByHostSocketId.get(hostSocketId);
		if (session && session.viewers.size > 0) {
			status = "in-session";
		}
	}

	deviceRegistry[deviceId] = {
		...(deviceRegistry[deviceId] || {}),
		deviceId,
		status,
		updatedAt: nowIso(),
	};
	writeJsonSafe(REGISTRY_FILE, deviceRegistry);
}

function createOrUpdateDevice(deviceId, hostIp) {
	deviceRegistry[deviceId] = {
		...(deviceRegistry[deviceId] || {}),
		deviceId,
		status: "online",
		hostIp,
		updatedAt: nowIso(),
	};
	writeJsonSafe(REGISTRY_FILE, deviceRegistry);
}

function removePendingRequest(requestId) {
	const request = pendingRequests.get(requestId);
	if (!request) {
		return;
	}
	clearTimeout(request.timer);
	pendingRequests.delete(requestId);
}

function getSession(hostSocketId) {
	return sessionsByHostSocketId.get(hostSocketId);
}

function createSession(hostSocketId, deviceId, mode) {
	let session = sessionsByHostSocketId.get(hostSocketId);
	if (session) {
		session.mode = mode;
		session.lastActivityAt = Date.now();
		return session;
	}

	session = {
		hostSocketId,
		deviceId,
		mode,
		createdAt: Date.now(),
		lastActivityAt: Date.now(),
		controllerViewerSocketId: "",
		viewers: new Map(), // viewerSocketId -> viewerState
	};
	sessionsByHostSocketId.set(hostSocketId, session);
	updateDeviceStatus(deviceId);
	return session;
}

function startLog(resumeToken, deviceId, viewerIp) {
	activeLogByResumeToken.set(resumeToken, {
		deviceId,
		viewerIp,
		startTime: nowIso(),
		startMs: Date.now(),
	});
}

function endLog(resumeToken) {
	const active = activeLogByResumeToken.get(resumeToken);
	if (!active) {
		return;
	}
	activeLogByResumeToken.delete(resumeToken);
	const endMs = Date.now();
	sessionLogs.push({
		deviceID: active.deviceId,
		viewerIP: active.viewerIp,
		sessionStartTime: active.startTime,
		sessionEndTime: new Date(endMs).toISOString(),
		durationSeconds: Math.max(1, Math.round((endMs - active.startMs) / 1000)),
	});
	writeJsonSafe(LOGS_FILE, sessionLogs);
}

function detachViewer(session, viewerSocketId, reasonForHost, reasonForViewer, preserveForRecovery) {
	const viewer = session.viewers.get(viewerSocketId);
	if (!viewer) {
		return;
	}

	if (viewer.reconnectTimer) {
		clearTimeout(viewer.reconnectTimer);
		viewer.reconnectTimer = null;
	}

	if (session.controllerViewerSocketId === viewerSocketId) {
		session.controllerViewerSocketId = "";
	}

	if (preserveForRecovery) {
		viewer.connected = false;
		viewer.lastSeenAt = Date.now();
		viewer.reconnectTimer = setTimeout(() => {
			const still = session.viewers.get(viewerSocketId);
			if (!still || still.connected) {
				return;
			}
			session.viewers.delete(viewerSocketId);
			viewerSocketIndex.delete(viewerSocketId);
			endLog(still.resumeToken);
			if (!session.controllerViewerSocketId) {
				assignFallbackController(session);
			}
			updateDeviceStatus(session.deviceId);
		}, RECONNECT_GRACE_MS);
	} else {
		session.viewers.delete(viewerSocketId);
		viewerSocketIndex.delete(viewerSocketId);
		endLog(viewer.resumeToken);
		if (!session.controllerViewerSocketId) {
			assignFallbackController(session);
		}
	}

	const hostSocket = io.sockets.sockets.get(session.hostSocketId);
	if (hostSocket) {
		hostSocket.emit("peer-disconnected", {
			reason: reasonForHost,
			viewerSocketId,
			recoverable: preserveForRecovery,
		});
	}

	const viewerSocket = io.sockets.sockets.get(viewerSocketId);
	if (viewerSocket && !preserveForRecovery) {
		viewerSocket.emit("peer-disconnected", {
			reason: reasonForViewer,
			hostSocketId: session.hostSocketId,
		});
	}

	if (session.viewers.size === 0 && Date.now() - session.createdAt > SESSION_TTL_MS) {
		sessionsByHostSocketId.delete(session.hostSocketId);
	}
	updateDeviceStatus(session.deviceId);
}

function assignFallbackController(session) {
	for (const [viewerSocketId, viewer] of session.viewers.entries()) {
		if (viewer.connected) {
			session.controllerViewerSocketId = viewerSocketId;
			viewer.canControl = true;
			const viewerSocket = io.sockets.sockets.get(viewerSocketId);
			if (viewerSocket) {
				viewerSocket.emit("control-state", { canControl: true });
			}
			break;
		}
	}
}

function closeHostSession(hostSocketId, reasonForHost, reasonForViewer) {
	const session = sessionsByHostSocketId.get(hostSocketId);
	if (!session) {
		return;
	}

	for (const [viewerSocketId] of session.viewers.entries()) {
		detachViewer(session, viewerSocketId, reasonForHost, reasonForViewer, false);
	}

	sessionsByHostSocketId.delete(hostSocketId);
	updateDeviceStatus(session.deviceId);
}

function getHostSummary() {
	return Object.values(deviceRegistry).map((entry) => {
		const hostSocketId = hostSocketByDeviceId.get(entry.deviceId);
		const session = hostSocketId ? sessionsByHostSocketId.get(hostSocketId) : null;
		return {
			deviceId: entry.deviceId,
			status: entry.status,
			hostSocketId: hostSocketId || null,
			mode: session ? session.mode : null,
			viewerCount: session ? session.viewers.size : 0,
			updatedAt: entry.updatedAt,
		};
	});
}

function getSessionSummary() {
	const summaries = [];
	for (const [hostSocketId, session] of sessionsByHostSocketId.entries()) {
		summaries.push({
			hostSocketId,
			deviceId: session.deviceId,
			mode: session.mode,
			viewerCount: session.viewers.size,
			controllerViewerSocketId: session.controllerViewerSocketId || null,
			createdAt: new Date(session.createdAt).toISOString(),
			viewers: [...session.viewers.entries()].map(([viewerSocketId, viewer]) => ({
				viewerSocketId,
				connected: viewer.connected,
				canControl: viewer.canControl,
				viewerIp: viewer.viewerIp,
			})),
		});
	}
	return summaries;
}

function findLatestInstaller() {
	if (!fs.existsSync(DIST_DIR)) {
		return null;
	}

	const installers = fs
		.readdirSync(DIST_DIR)
		.filter((name) => /\.exe$/i.test(name) && !/uninstall/i.test(name))
		.map((name) => {
			const fullPath = path.join(DIST_DIR, name);
			const stat = fs.statSync(fullPath);
			return {
				name,
				fullPath,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
			};
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	return installers[0] || null;
}

ensureDataFiles();
server.setTimeout(25_000);

app.use(express.json());
app.use("/assets", express.static(PUBLIC_DIR));
app.use("/public", express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/host", (_req, res) => {
	res.sendFile(HOST_PAGE_FILE);
});

app.get("/host.html", (_req, res) => {
	res.sendFile(HOST_PAGE_FILE);
});

app.get("/viewer", (_req, res) => {
	res.sendFile(VIEWER_PAGE_FILE);
});

app.get("/viewer.html", (_req, res) => {
	res.sendFile(VIEWER_PAGE_FILE);
});

app.get("/renderer.js", (_req, res) => {
	res.sendFile(LEGACY_RENDERER_FILE);
});

app.get("/health", (_req, res) => {
	res.json({ status: "ok", message: "Remote support signaling server is running" });
});

app.get("/download/meta", (_req, res) => {
	const installer = findLatestInstaller();
	if (!installer) {
		res.status(404).json({
			available: false,
			message: "No installer found. Build with npm run build first.",
		});
		return;
	}

	res.json({
		available: true,
		name: installer.name,
		sizeBytes: installer.size,
		updatedAt: new Date(installer.mtimeMs).toISOString(),
		downloadUrl: "/download/windows",
	});
});

app.get("/download", (_req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/download/windows", (_req, res) => {
	const installer = findLatestInstaller();
	if (!installer) {
		res.status(404).json({
			available: false,
			message: "No installer found. Build with npm run build first.",
		});
		return;
	}

	res.download(installer.fullPath, installer.name);
});

app.get("/download/latest", (_req, res) => {
	const installer = findLatestInstaller();
	if (!installer) {
		res.status(404).json({
			available: false,
			message: "No installer found. Build with npm run build first.",
		});
		return;
	}

	res.setHeader("Content-Type", "application/octet-stream");
	res.setHeader("Content-Disposition", `attachment; filename="${installer.name}"`);
	res.sendFile(installer.fullPath);
});

app.get("/dashboard", (_req, res) => {
	res.sendFile(DASHBOARD_FILE);
});

app.get("/hosts", (_req, res) => {
	res.json({ hosts: getHostSummary() });
});

app.get("/hosts/:deviceId/status", (req, res) => {
	const deviceId = String(req.params.deviceId || "").trim();
	const found = deviceRegistry[deviceId] || { deviceId, status: "offline", updatedAt: null };
	res.json(found);
});

app.get("/sessions", (_req, res) => {
	res.json({ sessions: getSessionSummary() });
});

app.get("/logs", (_req, res) => {
	res.json({ logs: sessionLogs });
});

io.use((socket, next) => {
	const ip = getClientIp(socket);
	if (!canPassWindowLimit(socketRateLimitByIp, ip, SOCKET_WINDOW_MAX, SOCKET_WINDOW_MS)) {
		next(new Error("Too many signaling operations from this IP"));
		return;
	}
	next();
});

io.on("connection", (socket) => {
	socket.on("register-host", ({ deviceId, password, mode }) => {
		const normalizedDeviceId = String(deviceId || "").trim();
		const cleanPassword = String(password || "").trim();
		const hostMode = mode === "multi" ? "multi" : "single";

		if (!/^[A-Za-z0-9_-]{6,24}$/.test(normalizedDeviceId)) {
			socket.emit("error-message", "Invalid permanent device ID");
			return;
		}
		if (!/^\d{4}$/.test(cleanPassword)) {
			socket.emit("error-message", "Host password must be exactly 4 numeric digits");
			return;
		}

		const existingSocketId = hostSocketByDeviceId.get(normalizedDeviceId);
		if (existingSocketId && existingSocketId !== socket.id) {
			const existingSocket = io.sockets.sockets.get(existingSocketId);
			if (existingSocket) {
				existingSocket.emit("error-message", "Host session taken over by a new login");
				existingSocket.disconnect(true);
			}
		}

		const passwordSalt = crypto.randomBytes(16).toString("hex");
		const passwordHash = hashPassword(cleanPassword, passwordSalt);

		hostsBySocketId.set(socket.id, {
			deviceId: normalizedDeviceId,
			passwordHash,
			passwordSalt,
			mode: hostMode,
		});
		hostSocketByDeviceId.set(normalizedDeviceId, socket.id);
		socket.data.role = "host";
		socket.data.deviceId = normalizedDeviceId;

		createOrUpdateDevice(normalizedDeviceId, getClientIp(socket));
		createSession(socket.id, normalizedDeviceId, hostMode);

		socket.emit("host-registered", {
			deviceId: normalizedDeviceId,
			mode: hostMode,
			status: "online",
		});
	});

	socket.on("request-viewer-connection", ({ deviceId, password, resumeToken }) => {
		const ip = getClientIp(socket);
		if (!canPassWindowLimit(viewerRateLimitByIp, ip, VIEWER_CONNECT_LIMIT, SOCKET_WINDOW_MS)) {
			socket.emit("error-message", "Too many connection attempts. Please wait.");
			return;
		}

		const normalizedDeviceId = String(deviceId || "").trim();
		const cleanPassword = String(password || "").trim();
		if (!/^\d{4}$/.test(cleanPassword)) {
			socket.emit("error-message", "Temporary password must be exactly 4 digits");
			return;
		}
		const incomingResumeToken = String(resumeToken || "").trim();

		if (!normalizedDeviceId) {
			socket.emit("error-message", "Device ID is required");
			return;
		}

		const hostSocketId = hostSocketByDeviceId.get(normalizedDeviceId);
		const hostInfo = hostSocketId ? hostsBySocketId.get(hostSocketId) : null;
		if (!hostSocketId || !hostInfo) {
			socket.emit("error-message", "Host is offline");
			return;
		}

		const expected = hashPassword(cleanPassword, hostInfo.passwordSalt);
		if (!secureEqual(expected, hostInfo.passwordHash)) {
			socket.emit("error-message", "Invalid password");
			return;
		}

		const session = createSession(hostSocketId, normalizedDeviceId, hostInfo.mode);
		session.lastActivityAt = Date.now();

		if (incomingResumeToken) {
			for (const [viewerSocketId, viewer] of session.viewers.entries()) {
				if (viewer.resumeToken !== incomingResumeToken) {
					continue;
				}
				if (viewer.reconnectTimer) {
					clearTimeout(viewer.reconnectTimer);
					viewer.reconnectTimer = null;
				}
				session.viewers.delete(viewerSocketId);
				viewer.connected = true;
				session.viewers.set(socket.id, viewer);
				viewerSocketIndex.delete(viewerSocketId);
				viewerSocketIndex.set(socket.id, {
					hostSocketId,
					deviceId: normalizedDeviceId,
					resumeToken: incomingResumeToken,
				});
				if (session.controllerViewerSocketId === viewerSocketId) {
					session.controllerViewerSocketId = socket.id;
				}
				socket.data.role = "viewer";
				socket.data.deviceId = normalizedDeviceId;
				socket.emit("viewer-approved", {
					hostSocketId,
					deviceId: normalizedDeviceId,
					resumeToken: incomingResumeToken,
					canControl: viewer.canControl,
					resumed: true,
				});
				const hostSocket = io.sockets.sockets.get(hostSocketId);
				if (hostSocket) {
					hostSocket.emit("viewer-resumed", {
						viewerSocketId: socket.id,
						deviceId: normalizedDeviceId,
						canControl: viewer.canControl,
					});
				}
				updateDeviceStatus(normalizedDeviceId);
				return;
			}
		}

		if (session.mode === "single" && session.viewers.size >= 1) {
			socket.emit("error-message", "Host is in single viewer mode and currently busy");
			return;
		}

		const requestId = randomId("req");
		const timer = setTimeout(() => {
			removePendingRequest(requestId);
			const viewerSocket = io.sockets.sockets.get(socket.id);
			if (viewerSocket) {
				viewerSocket.emit("connection-denied", { reason: "Connection request timed out" });
			}
		}, REQUEST_TIMEOUT_MS);

		pendingRequests.set(requestId, {
			requestId,
			hostSocketId,
			viewerSocketId: socket.id,
			deviceId: normalizedDeviceId,
			viewerIp: ip,
			timer,
		});

		socket.data.role = "viewer";
		socket.data.deviceId = normalizedDeviceId;

		io.to(hostSocketId).emit("connection-request", {
			requestId,
			viewerSocketId: socket.id,
			deviceId: normalizedDeviceId,
			viewerIp: ip,
			mode: session.mode,
		});
		socket.emit("approval-pending", { requestId, deviceId: normalizedDeviceId });
	});

	socket.on("host-connection-response", ({ requestId, allow }) => {
		const request = pendingRequests.get(String(requestId || ""));
		if (!request || request.hostSocketId !== socket.id) {
			return;
		}

		removePendingRequest(request.requestId);
		const viewerSocket = io.sockets.sockets.get(request.viewerSocketId);
		if (!viewerSocket) {
			return;
		}

		if (!allow) {
			viewerSocket.emit("connection-denied", { reason: "Host denied the request" });
			socket.emit("connection-denied", { reason: "Request denied" });
			return;
		}

		const hostInfo = hostsBySocketId.get(socket.id);
		if (!hostInfo) {
			viewerSocket.emit("connection-denied", { reason: "Host is unavailable" });
			return;
		}

		const session = createSession(socket.id, request.deviceId, hostInfo.mode);
		const resumeToken = randomId("resume");
		const canControl = !session.controllerViewerSocketId;
		if (canControl) {
			session.controllerViewerSocketId = viewerSocket.id;
		}
		const viewerState = {
			resumeToken,
			viewerIp: request.viewerIp,
			connected: true,
			canControl,
			joinedAt: Date.now(),
			lastSeenAt: Date.now(),
			reconnectTimer: null,
		};
		session.viewers.set(viewerSocket.id, viewerState);
		viewerSocketIndex.set(viewerSocket.id, {
			hostSocketId: socket.id,
			deviceId: request.deviceId,
			resumeToken,
		});
		session.lastActivityAt = Date.now();
		startLog(resumeToken, request.deviceId, request.viewerIp);
		updateDeviceStatus(request.deviceId);

		socket.emit("viewer-approved", {
			viewerSocketId: viewerSocket.id,
			deviceId: request.deviceId,
			resumeToken,
			canControl,
			mode: session.mode,
		});
		viewerSocket.emit("viewer-approved", {
			hostSocketId: socket.id,
			deviceId: request.deviceId,
			resumeToken,
			canControl,
			mode: session.mode,
			resumed: false,
		});
	});

	socket.on("session-connected", ({ deviceId }) => {
		const normalizedDeviceId = String(deviceId || "");
		if (socket.data.role === "host") {
			const session = sessionsByHostSocketId.get(socket.id);
			if (session && session.deviceId === normalizedDeviceId) {
				session.lastActivityAt = Date.now();
			}
			return;
		}

		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (session && session.deviceId === normalizedDeviceId) {
			session.lastActivityAt = Date.now();
		}
	});

	socket.on("offer", ({ deviceId, offer, toViewerSocketId }) => {
		if (!offer) {
			return;
		}
		const session = sessionsByHostSocketId.get(socket.id);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}

		const targetViewerSocketId = String(toViewerSocketId || "");
		const viewer = session.viewers.get(targetViewerSocketId);
		if (!viewer || !viewer.connected) {
			return;
		}

		io.to(targetViewerSocketId).emit("offer", {
			offer,
			deviceId: session.deviceId,
			from: socket.id,
		});
		session.lastActivityAt = Date.now();
	});

	socket.on("answer", ({ deviceId, answer }) => {
		if (!answer) {
			return;
		}
		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		io.to(viewerMeta.hostSocketId).emit("answer", {
			answer,
			deviceId: session.deviceId,
			from: socket.id,
		});
		session.lastActivityAt = Date.now();
	});

	socket.on("ice-candidate", ({ deviceId, candidate, toViewerSocketId }) => {
		if (!candidate) {
			return;
		}
		const normalizedDeviceId = String(deviceId || "");
		if (socket.data.role === "host") {
			const session = sessionsByHostSocketId.get(socket.id);
			if (!session || session.deviceId !== normalizedDeviceId) {
				return;
			}

			const targetViewerSocketId = String(toViewerSocketId || "");
			const viewer = session.viewers.get(targetViewerSocketId);
			if (!viewer || !viewer.connected) {
				return;
			}

			io.to(targetViewerSocketId).emit("ice-candidate", {
				candidate,
				deviceId: normalizedDeviceId,
				from: socket.id,
			});
			session.lastActivityAt = Date.now();
			return;
		}

		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== normalizedDeviceId) {
			return;
		}
		io.to(viewerMeta.hostSocketId).emit("ice-candidate", {
			candidate,
			deviceId: normalizedDeviceId,
			from: socket.id,
		});
		session.lastActivityAt = Date.now();
	});

	socket.on("remote-input", ({ deviceId, event }) => {
		if (!event || typeof event !== "object") {
			return;
		}
		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		const viewer = session.viewers.get(socket.id);
		if (!viewer || !viewer.canControl || session.controllerViewerSocketId !== socket.id) {
			socket.emit("control-state", { canControl: false, reason: "watch-only" });
			return;
		}
		io.to(viewerMeta.hostSocketId).emit("remote-input", { deviceId: session.deviceId, event, viewerSocketId: socket.id });
		session.lastActivityAt = Date.now();
	});

	socket.on("request-control", ({ deviceId }) => {
		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		const requestId = randomId("ctrl");
		const timer = setTimeout(() => {
			controlRequests.delete(requestId);
			socket.emit("control-state", { canControl: false, reason: "control request timed out" });
		}, 20_000);
		controlRequests.set(requestId, {
			requestId,
			hostSocketId: session.hostSocketId,
			viewerSocketId: socket.id,
			timer,
		});
		io.to(session.hostSocketId).emit("control-request", {
			requestId,
			viewerSocketId: socket.id,
			deviceId: session.deviceId,
		});
	});

	socket.on("host-control-response", ({ requestId, allow }) => {
		const request = controlRequests.get(String(requestId || ""));
		if (!request || request.hostSocketId !== socket.id) {
			return;
		}
		clearTimeout(request.timer);
		controlRequests.delete(request.requestId);

		const session = sessionsByHostSocketId.get(request.hostSocketId);
		if (!session) {
			return;
		}
		const viewer = session.viewers.get(request.viewerSocketId);
		if (!viewer) {
			return;
		}

		if (!allow) {
			io.to(request.viewerSocketId).emit("control-state", { canControl: false, reason: "Host denied control" });
			return;
		}

		if (session.controllerViewerSocketId && session.controllerViewerSocketId !== request.viewerSocketId) {
			const previous = session.viewers.get(session.controllerViewerSocketId);
			if (previous) {
				previous.canControl = false;
				io.to(session.controllerViewerSocketId).emit("control-state", { canControl: false, reason: "control transferred" });
			}
		}
		session.controllerViewerSocketId = request.viewerSocketId;
		viewer.canControl = true;
		io.to(request.viewerSocketId).emit("control-state", { canControl: true });
	});

	socket.on("host-clipboard", ({ deviceId, text }) => {
		const session = sessionsByHostSocketId.get(socket.id);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		for (const [viewerSocketId, viewer] of session.viewers.entries()) {
			if (viewer.connected) {
				io.to(viewerSocketId).emit("host-clipboard", { text: String(text || "") });
			}
		}
	});

	socket.on("viewer-clipboard", ({ deviceId, text }) => {
		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		io.to(viewerMeta.hostSocketId).emit("viewer-clipboard", { text: String(text || ""), viewerSocketId: socket.id });
	});

	socket.on("host-disconnect-session", ({ deviceId }) => {
		const session = sessionsByHostSocketId.get(socket.id);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		closeHostSession(socket.id, "host ended the session", "host ended the session");
	});

	socket.on("viewer-disconnect-session", ({ deviceId }) => {
		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (!session || session.deviceId !== String(deviceId || "")) {
			return;
		}
		detachViewer(session, socket.id, "viewer disconnected", "viewer disconnected", false);
	});

	socket.on("connection-state", ({ deviceId, state }) => {
		const normalizedDeviceId = String(deviceId || "");
		if (socket.data.role === "host") {
			const session = sessionsByHostSocketId.get(socket.id);
			if (!session || session.deviceId !== normalizedDeviceId) {
				return;
			}
			for (const [viewerSocketId, viewer] of session.viewers.entries()) {
				if (viewer.connected) {
					io.to(viewerSocketId).emit("connection-state", { state: String(state || "") });
				}
			}
			return;
		}

		const viewerMeta = viewerSocketIndex.get(socket.id);
		if (!viewerMeta) {
			return;
		}
		const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
		if (session && session.deviceId === normalizedDeviceId) {
			io.to(viewerMeta.hostSocketId).emit("connection-state", { state: String(state || "") });
		}
	});

	socket.on("disconnect", () => {
		for (const [requestId, request] of pendingRequests.entries()) {
			if (request.viewerSocketId === socket.id || request.hostSocketId === socket.id) {
				removePendingRequest(requestId);
				if (request.viewerSocketId !== socket.id) {
					io.to(request.viewerSocketId).emit("connection-denied", { reason: "Host disconnected" });
				}
			}
		}

		for (const [requestId, request] of controlRequests.entries()) {
			if (request.viewerSocketId === socket.id || request.hostSocketId === socket.id) {
				clearTimeout(request.timer);
				controlRequests.delete(requestId);
			}
		}

		if (socket.data.role === "host") {
			const hostInfo = hostsBySocketId.get(socket.id);
			if (hostInfo) {
				hostsBySocketId.delete(socket.id);
				hostSocketByDeviceId.delete(hostInfo.deviceId);
				closeHostSession(socket.id, "viewer disconnected", "host disconnected");
				updateDeviceStatus(hostInfo.deviceId);
			}
		}

		if (socket.data.role === "viewer") {
			const viewerMeta = viewerSocketIndex.get(socket.id);
			if (viewerMeta) {
				const session = sessionsByHostSocketId.get(viewerMeta.hostSocketId);
				if (session) {
					detachViewer(session, socket.id, "viewer temporarily disconnected", "disconnected", true);
				}
				viewerSocketIndex.delete(socket.id);
			}
		}
	});
});

server.listen(PORT, () => {
	console.log(`Signaling server listening on port ${PORT}`);
});

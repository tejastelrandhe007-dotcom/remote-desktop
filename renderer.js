(() => {
	const rtcConfig = {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "stun:stun1.l.google.com:19302" },
			{
				urls: "turn:YOUR_SERVER_IP:3478",
				username: "test",
				credential: "test123",
			},
		],
	};

	const SIGNALING_URL_STORAGE_KEY = "remoteDesktop.signalingUrl";

	function getDefaultServerUrl() {
		const queryServer = new URLSearchParams(window.location.search).get("server");
		if (queryServer) {
			return queryServer.trim();
		}

		const saved = window.localStorage.getItem(SIGNALING_URL_STORAGE_KEY);
		if (saved) {
			return saved.trim();
		}

		if (window.location.protocol === "http:" || window.location.protocol === "https:") {
			return window.location.origin;
		}

		return "";
	}

	function prepareServerUrlInput(serverInput) {
		if (!serverInput) {
			return;
		}
		if (!serverInput.value.trim()) {
			serverInput.value = getDefaultServerUrl();
		}
	}

	function saveServerUrl(serverUrl) {
		if (!serverUrl) {
			return;
		}
		window.localStorage.setItem(SIGNALING_URL_STORAGE_KEY, serverUrl);
	}

	const startBtn = document.getElementById("startBtn");
	const connectBtn = document.getElementById("connectBtn");

	if (startBtn) {
		setupHost();
		return;
	}

	if (connectBtn) {
		setupViewer();
	}

	function setupHost() {
		const roomInput = document.getElementById("roomId");
		const serverInput = document.getElementById("serverUrl");
		const deviceIdDisplay = document.getElementById("deviceIdDisplay");
		const statusText = document.getElementById("status");
		const preview = document.getElementById("preview");

		let socket = null;
		let peerConnection = null;
		let localStream = null;
		let currentDeviceId = "";
		let isStarting = false;
		let isRestartingIce = false;
		let pendingIceCandidates = [];

		let robot = null;
		try {
			if (typeof window.require === "function") {
				robot = window.require("robotjs");
			} else if (typeof require === "function") {
				robot = require("robotjs");
			}
		} catch (_error) {
			robot = null;
		}

		function setStatus(message) {
			statusText.textContent = `Status: ${message}`;
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
					const x = Math.round(xRatio * (screen.width - 1));
					const y = Math.round(yRatio * (screen.height - 1));
					robot.moveMouseSmooth(x, y);
					break;
				}
				case "mouse-down":
				case "mouse-up": {
					const action = inputEvent.type === "mouse-down" ? "down" : "up";
					robot.mouseToggle(action, toRobotMouseButton(Number(inputEvent.button) || 0));
					break;
				}
				case "mouse-wheel": {
					robot.scrollMouse(Number(inputEvent.deltaX) || 0, Number(inputEvent.deltaY) || 0);
					break;
				}
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

		function cleanupPeer() {
			if (peerConnection) {
				peerConnection.close();
				peerConnection = null;
			}
			pendingIceCandidates = [];
			isRestartingIce = false;
		}

		async function flushPendingIceCandidates() {
			if (!peerConnection || !peerConnection.remoteDescription) {
				return;
			}

			while (pendingIceCandidates.length > 0) {
				const candidate = pendingIceCandidates.shift();
				try {
					await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
				} catch (_error) {
					// Ignore stale or malformed candidates.
				}
			}
		}

		function createPeerConnection() {
			cleanupPeer();
			peerConnection = new RTCPeerConnection(rtcConfig);

			if (localStream) {
				for (const track of localStream.getTracks()) {
					peerConnection.addTrack(track, localStream);
				}
			}

			peerConnection.onicecandidate = (event) => {
				if (event.candidate && socket && currentDeviceId) {
					socket.emit("ice-candidate", {
						deviceId: currentDeviceId,
						candidate: event.candidate,
					});
				}
			};

			peerConnection.onconnectionstatechange = () => {
				if (peerConnection.connectionState === "connected") {
					setStatus("displaying remote screen");
					return;
				}

				if (peerConnection.connectionState === "failed" && !isRestartingIce) {
					isRestartingIce = true;
					setStatus("p2p failed, retrying via TURN relay");
					createAndSendOffer(true)
						.catch((error) => {
							setStatus(`turn retry failed: ${error.message}`);
						})
						.finally(() => {
							isRestartingIce = false;
						});
					return;
				}

				if (["disconnected", "closed"].includes(peerConnection.connectionState)) {
					setStatus(`peer ${peerConnection.connectionState}`);
				}
			};

			return peerConnection;
		}

		async function createAndSendOffer(isIceRestart = false) {
			if (!socket || !currentDeviceId) {
				return;
			}

			const pc = createPeerConnection();
			const offer = await pc.createOffer(isIceRestart ? { iceRestart: true } : undefined);
			await pc.setLocalDescription(offer);
			socket.emit("offer", { deviceId: currentDeviceId, offer });
			setStatus(isIceRestart ? "retrying connectivity (turn fallback)" : "offer sent, waiting for answer");
		}

		async function captureDisplay() {
			localStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					width: { ideal: 1280, max: 1280 },
					height: { ideal: 720, max: 720 },
					frameRate: { ideal: 20, max: 20 },
				},
				audio: false,
			});

			preview.srcObject = localStream;
			const [videoTrack] = localStream.getVideoTracks();
			if (videoTrack) {
				videoTrack.onended = () => {
					setStatus("screen share stopped");
					cleanupPeer();
				};
			}
		}

		function bindSocket(serverUrl) {
			saveServerUrl(serverUrl);
			socket = io(serverUrl, {
				timeout: 6000,
				reconnection: true,
				transports: ["websocket", "polling"],
			});

			socket.on("connect", () => {
				setStatus("registering host");
				socket.emit("register-host");
			});

			socket.on("host-registered", ({ deviceId }) => {
				currentDeviceId = String(deviceId);
				roomInput.value = currentDeviceId;
				deviceIdDisplay.textContent = `Device ID: ${currentDeviceId}`;
				setStatus("host registered, waiting for viewer");
			});

			socket.on("peer-joined", async ({ deviceId }) => {
				if (String(deviceId) !== currentDeviceId) {
					return;
				}
				setStatus("viewer connected, creating offer");
				try {
					await createAndSendOffer();
				} catch (error) {
					setStatus(`offer failed: ${error.message}`);
				}
			});

			socket.on("answer", async ({ answer }) => {
				if (!peerConnection) {
					return;
				}
				await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
				await flushPendingIceCandidates();
				setStatus("displaying remote screen");
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
				} catch (_error) {
					// Ignore stale or out-of-order ICE candidates.
				}
			});

			socket.on("remote-input", (payload) => {
				const inputEvent = payload && payload.event ? payload.event : payload;
				if (!inputEvent || !inputEvent.type) {
					return;
				}
				executeRemoteInput(inputEvent);
			});

			socket.on("peer-left", () => {
				cleanupPeer();
				setStatus("viewer disconnected");
			});

			socket.on("disconnect", (reason) => {
				cleanupPeer();
				setStatus(`signaling disconnected: ${reason}`);
			});

			socket.on("error-message", (message) => {
				setStatus(String(message || "server error"));
			});
		}

		startBtn.addEventListener("click", async () => {
			if (isStarting) {
				return;
			}

			const serverUrl = serverInput.value.trim();
			if (!serverUrl) {
				setStatus("enter signaling server URL");
				return;
			}

			isStarting = true;
			try {
				if (!localStream) {
					setStatus("capturing display");
					await captureDisplay();
				}

				if (!socket) {
					bindSocket(serverUrl);
				} else if (socket.connected) {
					socket.emit("register-host");
				}
			} catch (error) {
				setStatus(`failed: ${error.message}`);
			} finally {
				isStarting = false;
			}
		});

		prepareServerUrlInput(serverInput);
	}

	function setupViewer() {
		const connectBtn = document.getElementById("connectBtn");
		const remoteDeviceIdInput = document.getElementById("remoteDeviceId");
		const serverInput = document.getElementById("serverUrl");
		const statusText = document.getElementById("status");
		const remoteVideo = document.getElementById("remoteVideo");

		let socket = null;
		let peerConnection = null;
		let currentDeviceId = "";
		let pendingMouse = null;
		let flushScheduled = false;
		let pendingIceCandidates = [];

		function setStatus(message) {
			statusText.textContent = `Status: ${message}`;
		}

		function cleanupPeer() {
			if (peerConnection) {
				peerConnection.close();
				peerConnection = null;
			}
			pendingIceCandidates = [];
			remoteVideo.srcObject = null;
		}

		async function flushPendingIceCandidates() {
			if (!peerConnection || !peerConnection.remoteDescription) {
				return;
			}

			while (pendingIceCandidates.length > 0) {
				const candidate = pendingIceCandidates.shift();
				try {
					await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
				} catch (_error) {
					// Ignore stale or malformed candidates.
				}
			}
		}

		function emitRemoteInput(inputEvent) {
			if (!socket || !socket.connected || !currentDeviceId) {
				return;
			}
			socket.emit("remote-input", {
				deviceId: currentDeviceId,
				event: inputEvent,
			});
		}

		function ensurePeerConnection() {
			if (peerConnection) {
				return peerConnection;
			}

			peerConnection = new RTCPeerConnection(rtcConfig);

			peerConnection.ontrack = (event) => {
				if (event.streams && event.streams[0]) {
					remoteVideo.srcObject = event.streams[0];
					setStatus("displaying remote screen");
				}
			};

			peerConnection.onicecandidate = (event) => {
				if (!event.candidate || !socket || !currentDeviceId) {
					return;
				}
				socket.emit("ice-candidate", {
					deviceId: currentDeviceId,
					candidate: event.candidate,
				});
			};

			peerConnection.onconnectionstatechange = () => {
				if (peerConnection.connectionState === "connected") {
					setStatus("displaying remote screen");
				} else if (["disconnected", "failed", "closed"].includes(peerConnection.connectionState)) {
					setStatus(`peer ${peerConnection.connectionState}`);
				}
			};

			return peerConnection;
		}

		function clamp01(value) {
			return Math.max(0, Math.min(1, value));
		}

		function getMouseRatio(event) {
			const rect = remoteVideo.getBoundingClientRect();
			if (!rect.width || !rect.height) {
				return { xRatio: 0, yRatio: 0 };
			}
			return {
				xRatio: clamp01((event.clientX - rect.left) / rect.width),
				yRatio: clamp01((event.clientY - rect.top) / rect.height),
			};
		}

		function queueMouseMove(event) {
			pendingMouse = getMouseRatio(event);
			if (flushScheduled) {
				return;
			}

			flushScheduled = true;
			setTimeout(() => {
				flushScheduled = false;
				if (!pendingMouse) {
					return;
				}
				emitRemoteInput({ type: "mouse-move", ...pendingMouse });
				pendingMouse = null;
			}, 16);
		}

		function bindSocket(serverUrl) {
			saveServerUrl(serverUrl);
			socket = io(serverUrl, {
				timeout: 6000,
				reconnection: true,
				transports: ["websocket", "polling"],
			});

			socket.on("connect", () => {
				socket.emit("connect-to-host", { deviceId: currentDeviceId });
				setStatus("connecting to host");
			});

			socket.on("viewer-connected", ({ deviceId }) => {
				if (String(deviceId) === currentDeviceId) {
					setStatus("connecting to host");
				}
			});

			socket.on("offer", async ({ offer }) => {
				try {
					const pc = ensurePeerConnection();
					await pc.setRemoteDescription(new RTCSessionDescription(offer));
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);
					socket.emit("answer", { deviceId: currentDeviceId, answer });
					await flushPendingIceCandidates();
					setStatus("connecting to host");
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
				} catch (_error) {
					// Ignore stale or out-of-order ICE candidates.
				}
			});

			socket.on("peer-left", () => {
				cleanupPeer();
				setStatus("host disconnected");
			});

			socket.on("disconnect", (reason) => {
				cleanupPeer();
				setStatus(`signaling disconnected: ${reason}`);
			});

			socket.on("error-message", (message) => {
				setStatus(String(message || "server error"));
			});
		}

		connectBtn.addEventListener("click", () => {
			const nextDeviceId = remoteDeviceIdInput.value.trim();
			const serverUrl = serverInput.value.trim();

			if (!/^\d{9}$/.test(nextDeviceId)) {
				setStatus("please enter a valid 9-digit device id");
				return;
			}
			if (!serverUrl) {
				setStatus("enter signaling server URL");
				return;
			}

			currentDeviceId = nextDeviceId;

			if (socket) {
				socket.disconnect();
				socket = null;
			}

			cleanupPeer();
			bindSocket(serverUrl);
			setStatus("connecting to host");
		});

		prepareServerUrlInput(serverInput);

		remoteVideo.addEventListener("mousemove", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			queueMouseMove(event);
		});

		remoteVideo.addEventListener("mousedown", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			remoteVideo.focus();
			const pos = getMouseRatio(event);
			emitRemoteInput({ type: "mouse-move", ...pos });
			emitRemoteInput({ type: "mouse-down", button: event.button });
			event.preventDefault();
		});

		remoteVideo.addEventListener("mouseup", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			emitRemoteInput({ type: "mouse-up", button: event.button });
			event.preventDefault();
		});

		remoteVideo.addEventListener("wheel", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			emitRemoteInput({
				type: "mouse-wheel",
				deltaX: Math.round(event.deltaX),
				deltaY: Math.round(event.deltaY),
			});
			event.preventDefault();
		});

		remoteVideo.addEventListener("contextmenu", (event) => {
			event.preventDefault();
		});

		window.addEventListener("keydown", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			if (document.activeElement && document.activeElement.tagName === "INPUT") {
				return;
			}
			emitRemoteInput({ type: "key-down", key: event.key });
			event.preventDefault();
		});

		window.addEventListener("keyup", (event) => {
			if (!remoteVideo.srcObject) {
				return;
			}
			if (document.activeElement && document.activeElement.tagName === "INPUT") {
				return;
			}
			emitRemoteInput({ type: "key-up", key: event.key });
			event.preventDefault();
		});
	}
})();
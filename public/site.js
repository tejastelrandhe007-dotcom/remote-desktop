async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

async function loadReleaseMeta() {
  const metaEl = document.getElementById("releaseMeta");
  const downloadBtn = document.getElementById("downloadBtn");

  try {
    const meta = await fetchJson("/download/meta");
    downloadBtn.href = meta.downloadUrl;
    metaEl.textContent = `Latest build: ${meta.name} (${formatBytes(meta.sizeBytes)}) | Updated: ${new Date(meta.updatedAt).toLocaleString()}`;
  } catch (error) {
    metaEl.textContent = "Installer not available yet. Run npm run build on the host server.";
    downloadBtn.removeAttribute("href");
    downloadBtn.style.pointerEvents = "none";
    downloadBtn.style.opacity = "0.6";
  }
}

async function loadStats() {
  try {
    const [hostsData, sessionsData, logsData] = await Promise.all([
      fetchJson("/hosts"),
      fetchJson("/sessions"),
      fetchJson("/logs"),
    ]);

    const hosts = Array.isArray(hostsData.hosts) ? hostsData.hosts : [];
    const sessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
    const logs = Array.isArray(logsData.logs) ? logsData.logs : [];
    const onlineCount = hosts.filter((h) => h.status === "online" || h.status === "in-session").length;

    document.getElementById("hostsCount").textContent = String(hosts.length);
    document.getElementById("sessionsCount").textContent = String(sessions.length);
    document.getElementById("logsCount").textContent = String(logs.length);
    document.getElementById("onlineCount").textContent = String(onlineCount);
  } catch {
    // Keep fallback numbers when backend APIs are not yet available.
  }
}

loadReleaseMeta();
loadStats();
setInterval(loadStats, 8000);

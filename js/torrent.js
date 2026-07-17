// Torrent fetch page, powered by WebTorrent. The library is loaded from CDN
// only when the user starts a fetch. Browser WebTorrent reaches WebRTC peers
// via WebSocket trackers only, so discovery can be slow for torrents with few
// web-capable seeds — the UI keeps reporting peer/speed status while it tries.

const $ = (id) => document.getElementById(id);

const torrentInput = $('torrent-input');
const fetchBtn = $('fetch-btn');
const fileBtn = $('file-btn');
const torrentFileInput = $('torrent-file-input');
const cancelBtn = $('cancel-btn');
const runControls = $('run-controls');
const statusLine = $('status-line');
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const torrentMeta = $('torrent-meta');
const torrentName = $('torrent-name');
const fileTbody = $('file-tbody');
const logEl = $('log');

// Public WebSocket trackers — the only way browsers can discover peers.
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

let client = null;          // active WebTorrent client (one per fetch)
let heartbeat = null;
let objectUrls = [];

// ---------- UI helpers ----------

function log(msg, cls) {
  logEl.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusLine.textContent = msg;
}

function setProgress(fraction, text) {
  progressWrap.classList.remove('hidden');
  if (fraction == null) {
    progressFill.style.width = '100%';
    progressFill.classList.add('indeterminate');
  } else {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = (fraction * 100).toFixed(1) + '%';
  }
  progressText.textContent = text || '';
}

function formatBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function startRun(statusMsg) {
  stopRun(); // tear down any previous fetch
  runControls.classList.remove('hidden');
  progressWrap.classList.add('hidden');
  torrentMeta.classList.add('hidden');
  fileTbody.textContent = '';
  logEl.classList.add('hidden');
  logEl.textContent = '';
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
  fetchBtn.disabled = true;
  fileBtn.disabled = true;
  setStatus(statusMsg);
}

function stopRun() {
  clearInterval(heartbeat);
  heartbeat = null;
  if (client) {
    client.destroy();
    client = null;
  }
  runControls.classList.add('hidden');
  fetchBtn.disabled = false;
  fileBtn.disabled = false;
}

cancelBtn.addEventListener('click', () => {
  log('Cancelled.', 'log-warn');
  setStatus('Cancelled');
  stopRun();
});

// ---------- WebTorrent ----------

function loadWebTorrent() {
  if (window.WebTorrent) return Promise.resolve(window.WebTorrent);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/webtorrent@2/dist/webtorrent.min.js';
    s.onload = () => resolve(window.WebTorrent);
    s.onerror = () => reject(new Error('failed to load the WebTorrent library from CDN'));
    document.head.appendChild(s);
  });
}

function normalizeTorrentId(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('magnet:')) return s;
  const m = s.toLowerCase().match(/^[a-f0-9]{40}$/);
  if (m) return `magnet:?xt=urn:btih:${m[0]}`;
  return null;
}

function renderFiles(torrent) {
  torrentMeta.classList.remove('hidden');
  torrentName.textContent = torrent.name;
  fileTbody.textContent = '';
  for (const file of torrent.files) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = file.path;
    const tdSize = document.createElement('td');
    tdSize.textContent = formatBytes(file.length);
    const tdBtn = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'Save';
    btn.disabled = true;
    btn.addEventListener('click', async () => {
      try {
        btn.disabled = true;
        btn.textContent = '…';
        const blob = await file.blob();
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        btn.textContent = 'Save';
        btn.disabled = false;
      } catch (err) {
        log(`Could not save ${file.name}: ${err.message}`, 'log-error');
        btn.textContent = 'Save';
        btn.disabled = false;
      }
    });
    tdBtn.appendChild(btn);
    tr.append(tdName, tdSize, tdBtn);
    fileTbody.appendChild(tr);
  }
}

function enableSaveButtons() {
  for (const btn of fileTbody.querySelectorAll('button')) btn.disabled = false;
}

async function startTorrent(torrentId, label) {
  startRun('Loading WebTorrent…');
  const startedAt = Date.now();
  try {
    log('Loading the WebTorrent library (first use only)…');
    const WebTorrent = await loadWebTorrent();
    if (!fetchBtn.disabled) return; // cancelled while loading

    log(`Starting torrent client for ${label}.`);
    setStatus('Connecting to trackers…');
    setProgress(null, 'Fetching metadata…');
    client = new WebTorrent();

    client.on('error', (err) => {
      log(`Client error: ${err.message}`, 'log-error');
      setStatus('Failed');
      stopRun();
    });

    const torrent = client.add(torrentId, { announce: TRACKERS });

    torrent.on('warning', (err) => log(`Warning: ${err.message}`, 'log-warn'));
    torrent.on('error', (err) => {
      log(`Torrent error: ${err.message}`, 'log-error');
      setStatus('Failed');
      stopRun();
    });

    torrent.on('infoHash', () => log(`Info hash: ${torrent.infoHash}`));

    torrent.on('wire', (wire) => {
      log(`Connected to peer ${wire.remoteAddress || wire.peerId?.slice(0, 8) || '(webrtc)'} (${torrent.numPeers} peer${torrent.numPeers === 1 ? '' : 's'})`);
    });

    torrent.on('metadata', () => {
      log(`Metadata received: "${torrent.name}" — ${torrent.files.length} file${torrent.files.length === 1 ? '' : 's'}, ${formatBytes(torrent.length)} total.`, 'log-ok');
      renderFiles(torrent);
    });

    torrent.on('done', () => {
      const took = Math.round((Date.now() - startedAt) / 1000);
      log(`Download complete: ${formatBytes(torrent.length)} in ${took}s. Every piece hash-checked. Still seeding to other web peers — use Cancel to stop.`, 'log-ok');
      setStatus('Done — seeding');
      setProgress(1, formatBytes(torrent.length));
      enableSaveButtons();
      clearInterval(heartbeat);
      heartbeat = null;
    });

    // Status heartbeat so slow discovery never looks like a hang.
    heartbeat = setInterval(() => {
      if (!client) return;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (!torrent.metadata) {
        setStatus(`Looking for peers… ${elapsed}s elapsed, ${torrent.numPeers} peers`);
        return;
      }
      setStatus(`Downloading… ${torrent.numPeers} peers, ${formatBytes(torrent.downloadSpeed)}/s`);
      setProgress(torrent.progress,
        `${formatBytes(torrent.downloaded)} of ${formatBytes(torrent.length)} (${(torrent.progress * 100).toFixed(1)}%)`);
    }, 2000);
  } catch (err) {
    log(`Error: ${err.message}`, 'log-error');
    setStatus('Failed');
    stopRun();
  }
}

// ---------- inputs ----------

fetchBtn.addEventListener('click', () => {
  const id = normalizeTorrentId(torrentInput.value);
  if (!id) {
    log('Please enter a magnet link or a 40-character info hash.', 'log-error');
    return;
  }
  startTorrent(id, id.length > 60 ? id.slice(0, 60) + '…' : id);
});

torrentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchBtn.click();
});

fileBtn.addEventListener('click', () => torrentFileInput.click());

torrentFileInput.addEventListener('change', async () => {
  const f = torrentFileInput.files[0];
  torrentFileInput.value = '';
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  startTorrent(buf, f.name);
});

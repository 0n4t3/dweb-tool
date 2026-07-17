// Blossom fetch page. Blossom blobs are plain HTTP GETs of
// https://<server>/<sha256>, so no SDK is needed — and because the hash IS
// the content hash, every download is verified locally with WebCrypto.

const $ = (id) => document.getElementById(id);

const hashInput = $('hash-input');
const filenameInput = $('filename-input');
const checkBtn = $('check-btn');
const downloadBtn = $('download-btn');
const serversBtn = $('servers-btn');
const serverCount = $('server-count');
const cancelBtn = $('cancel-btn');
const runControls = $('run-controls');
const statusLine = $('status-line');
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const serverTable = $('server-table');
const serverTbody = $('server-tbody');
const logEl = $('log');
const resultEl = $('result');
const downloadLink = $('download-link');
const resultInfo = $('result-info');

const modal = $('server-modal');
const modalClose = $('modal-close');
const serverList = $('server-list');
const newServerInput = $('new-server-input');
const addServerBtn = $('add-server-btn');
const resetServersBtn = $('reset-servers-btn');

const STORAGE_KEY = 'blossom-servers';
const BOOTSTRAP_URL = '/blossom-bootstrap.txt';
const PROBE_TIMEOUT_MS = 15 * 1000;
const CHUNK_SIZE = 1 << 20; // 1 MiB per range request
const MAX_PARALLEL_SERVERS = 6;

let servers = [];
let bootstrapServers = [];
let abortController = null;
let lastObjectUrl = null;
let probeResults = null; // last "check servers" results, invalidated on edits

// ---------- server list handling ----------

function normalizeServer(s) {
  s = s.trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

async function loadServers() {
  try {
    const res = await fetch(BOOTSTRAP_URL, { cache: 'no-store' });
    if (res.ok) {
      bootstrapServers = (await res.text())
        .split(',')
        .map(normalizeServer)
        .filter(Boolean);
    }
  } catch { /* no bootstrap file — start empty */ }

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      servers = JSON.parse(stored).map(normalizeServer).filter(Boolean);
      return;
    } catch { /* fall through to bootstrap */ }
  }
  servers = [...bootstrapServers];
}

function saveServers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  probeResults = null;
  updateServerCount();
}

function updateServerCount() {
  serverCount.textContent = `(${servers.length})`;
}

function renderServerList() {
  serverList.textContent = '';
  if (servers.length === 0) {
    const li = document.createElement('li');
    li.className = 'server-item muted';
    li.textContent = 'No servers configured.';
    serverList.appendChild(li);
    return;
  }
  for (const s of servers) {
    const li = document.createElement('li');
    li.className = 'server-item';
    const name = document.createElement('span');
    name.textContent = new URL(s).host;
    const rm = document.createElement('button');
    rm.className = 'server-remove';
    rm.textContent = 'remove';
    rm.addEventListener('click', () => {
      servers = servers.filter((x) => x !== s);
      saveServers();
      renderServerList();
    });
    li.append(name, rm);
    serverList.appendChild(li);
  }
}

function openModal() {
  renderServerList();
  modal.classList.remove('hidden');
  newServerInput.focus();
}

function closeModal() {
  modal.classList.add('hidden');
}

function addServer() {
  const s = normalizeServer(newServerInput.value);
  if (!s) return;
  if (!servers.includes(s)) {
    servers.push(s);
    saveServers();
  }
  newServerInput.value = '';
  renderServerList();
}

serversBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
addServerBtn.addEventListener('click', addServer);
newServerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addServer(); });
resetServersBtn.addEventListener('click', () => {
  servers = [...bootstrapServers];
  localStorage.removeItem(STORAGE_KEY);
  probeResults = null;
  updateServerCount();
  renderServerList();
});

// ---------- UI helpers (same pattern as the IPFS page) ----------

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

function startRun(statusMsg) {
  abortController = new AbortController();
  runControls.classList.remove('hidden');
  resultEl.classList.add('hidden');
  progressWrap.classList.add('hidden');
  logEl.classList.add('hidden');
  logEl.textContent = '';
  checkBtn.disabled = true;
  downloadBtn.disabled = true;
  setStatus(statusMsg);
  return abortController.signal;
}

function endRun() {
  runControls.classList.add('hidden');
  checkBtn.disabled = false;
  downloadBtn.disabled = false;
}

function formatBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function getHash() {
  const m = hashInput.value.trim().toLowerCase().match(/[a-f0-9]{64}/);
  if (!m) {
    log('Please enter a valid SHA-256 hash (64 hex characters) or a Blossom URL containing one.', 'log-error');
    return null;
  }
  return m[0];
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function offerDownload(bytes, source) {
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  const blob = new Blob([bytes]);
  lastObjectUrl = URL.createObjectURL(blob);
  downloadLink.href = lastObjectUrl;
  downloadLink.download = filenameInput.value.trim() || (getHash().slice(0, 16) + '.bin');
  resultInfo.textContent = `${formatBytes(blob.size)} · ${source}`;
  resultEl.classList.remove('hidden');
}

cancelBtn.addEventListener('click', () => {
  if (abortController) abortController.abort(new Error('cancelled by user'));
});

hashInput.addEventListener('input', () => {
  probeResults = null;
  serverTable.classList.add('hidden');
});

// ---------- probing ----------

function blobUrl(server, hash) {
  return `${server}/${hash}`;
}

async function probeServer(server, hash, signal) {
  const result = { server, ok: false, ranges: false, size: null, status: '…' };
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
  try {
    const res = await fetch(blobUrl(server, hash), {
      signal: probeSignal,
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    if (res.status === 206) {
      result.ok = true;
      result.ranges = true;
      const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
      if (m) result.size = Number(m[1]);
      result.status = 'has blob';
    } else if (res.ok) {
      result.ok = true;
      const len = res.headers.get('content-length');
      if (len) result.size = Number(len);
      result.status = 'has blob (no ranges)';
    } else {
      result.status = `HTTP ${res.status}`;
    }
    res.body?.cancel?.();
  } catch (err) {
    result.status = signal.aborted ? 'cancelled'
      : err.name === 'TimeoutError' ? 'timeout' : 'unreachable';
  }
  return result;
}

function renderServerTable(results) {
  serverTable.classList.remove('hidden');
  serverTbody.textContent = '';
  const sorted = [...results].sort((a, b) => Number(b.ok) - Number(a.ok));
  for (const r of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${new URL(r.server).host}</td>` +
      `<td class="${r.ok ? 'gw-ok' : 'gw-bad'}">${r.status}</td>` +
      `<td>${r.ranges ? 'yes' : 'no'}</td>` +
      `<td>${formatBytes(r.size)}</td>`;
    serverTbody.appendChild(tr);
  }
}

async function probeAll(hash, signal) {
  log(`Asking ${servers.length} Blossom servers about ${hash.slice(0, 16)}…`);
  const results = await Promise.all(servers.map((s) => probeServer(s, hash, signal)));
  probeResults = results;
  renderServerTable(results);
  return results;
}

async function checkServers() {
  const hash = getHash();
  if (!hash) return;
  if (servers.length === 0) { log('No servers configured — add some first.', 'log-error'); return; }
  const signal = startRun('Probing Blossom servers…');
  try {
    const results = await probeAll(hash, signal);
    const ok = results.filter((r) => r.ok);
    if (ok.length === 0) {
      log('No configured server holds this blob.', 'log-error');
      setStatus('Not found');
    } else {
      log(`${ok.length} of ${servers.length} servers hold this blob.`, 'log-ok');
      setStatus(`${ok.length} servers have it`);
    }
  } catch (err) {
    log(signal.aborted ? 'Cancelled.' : `Error: ${err.message}`, 'log-warn');
    setStatus(signal.aborted ? 'Cancelled' : 'Failed');
  } finally {
    endRun();
  }
}

// ---------- downloading ----------

async function fetchChunk(server, hash, start, end, signal) {
  const res = await fetch(blobUrl(server, hash), {
    signal,
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store',
  });
  if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== end - start + 1) throw new Error('short read');
  return buf;
}

async function download() {
  const hash = getHash();
  if (!hash) return;
  if (servers.length === 0) { log('No servers configured — add some first.', 'log-error'); return; }
  const signal = startRun('Preparing download…');
  const startedAt = Date.now();
  try {
    if (!probeResults) await probeAll(hash, signal);
    const usable = probeResults.filter((r) => r.ok);
    if (usable.length === 0) throw new Error('no configured server holds this blob');

    const ranged = usable.filter((r) => r.ranges && r.size != null);
    const sizes = new Set(ranged.map((r) => r.size));
    const size = ranged.length ? ranged[0].size : null;

    let bytes;
    let source;

    if (ranged.length >= 2 && sizes.size === 1 && size > CHUNK_SIZE * 2) {
      const sources = ranged.slice(0, MAX_PARALLEL_SERVERS).map((r) => r.server);
      log(`Downloading ${formatBytes(size)} in parallel from ${sources.length} servers: ${sources.map((s) => new URL(s).host).join(', ')}`, 'log-ok');

      const nChunks = Math.ceil(size / CHUNK_SIZE);
      const parts = new Array(nChunks);
      let next = 0;
      let done = 0;
      const perServer = new Map(sources.map((s) => [s, 0]));

      const worker = async (server) => {
        while (!signal.aborted) {
          const i = next++;
          if (i >= nChunks) return;
          const start = i * CHUNK_SIZE;
          const end = Math.min(size, start + CHUNK_SIZE) - 1;
          try {
            parts[i] = await fetchChunk(server, hash, start, end, signal);
            perServer.set(server, perServer.get(server) + 1);
          } catch (err) {
            if (signal.aborted) throw err;
            log(`${new URL(server).host} failed a chunk (${err.message}); others will pick it up.`, 'log-warn');
            next = Math.min(next, i);
            return;
          }
          done++;
          setProgress(done / nChunks, `${formatBytes(Math.min(done * CHUNK_SIZE, size))} of ${formatBytes(size)}`);
        }
      };

      await Promise.all(sources.map(worker));
      signal.throwIfAborted();

      // Second pass for chunks a retired worker left behind.
      for (let i = 0; i < nChunks; i++) {
        if (parts[i]) continue;
        const start = i * CHUNK_SIZE;
        const end = Math.min(size, start + CHUNK_SIZE) - 1;
        let fetched = false;
        for (const s of sources) {
          try {
            parts[i] = await fetchChunk(s, hash, start, end, signal);
            fetched = true;
            break;
          } catch { /* try next server */ }
        }
        if (!fetched) throw new Error(`could not fetch bytes ${start}-${end} from any server`);
      }

      bytes = new Uint8Array(size);
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }

      const summary = [...perServer.entries()]
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${new URL(s).host}: ${n}`)
        .join(', ');
      log(`All chunks received (${summary}).`, 'log-ok');
      source = `via ${sources.length} servers`;
    } else {
      const pick = ranged[0] ?? usable[0];
      const reason =
        ranged.length >= 2 && sizes.size === 1 ? 'file is small — one server is fastest' :
        ranged.length >= 2 ? 'servers disagree on the blob size' :
        ranged.length === 1 ? 'only one server supports range requests' :
        'no server supports range requests';
      log(`Downloading from a single server: ${new URL(pick.server).host} (${reason})`);
      const res = await fetch(blobUrl(pick.server, hash), { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(pick.server).host}`);
      const total = Number(res.headers.get('content-length')) || pick.size || null;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        setProgress(total ? received / total : null,
          total ? `${formatBytes(received)} of ${formatBytes(total)}` : `${formatBytes(received)} received`);
      }
      bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      source = `via ${new URL(pick.server).host}`;
    }

    setStatus('Verifying hash…');
    log('Verifying SHA-256 of the downloaded data…');
    const actual = await sha256Hex(bytes);
    if (actual !== hash) {
      throw new Error(`hash mismatch! Expected ${hash.slice(0, 16)}…, got ${actual.slice(0, 16)}… — the server(s) returned wrong data`);
    }

    const took = Math.round((Date.now() - startedAt) / 1000);
    log(`Done: ${formatBytes(bytes.length)} in ${took}s, SHA-256 verified.`, 'log-ok');
    setStatus('Done');
    setProgress(1, formatBytes(bytes.length));
    offerDownload(bytes, `${source} (verified)`);
  } catch (err) {
    if (signal.aborted) {
      log('Cancelled.', 'log-warn');
      setStatus('Cancelled');
    } else {
      log(`Error: ${err.message}`, 'log-error');
      setStatus('Failed');
    }
  } finally {
    endRun();
  }
}

checkBtn.addEventListener('click', checkServers);
downloadBtn.addEventListener('click', download);

await loadServers();
updateServerCount();

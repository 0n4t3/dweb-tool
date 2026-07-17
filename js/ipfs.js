// IPFS fetch page logic. Loaded as an ES module; Helia is imported lazily
// from esm.sh only when the user actually starts a p2p fetch.

const $ = (id) => document.getElementById(id);

const cidInput = $('cid-input');
const filenameInput = $('filename-input');
const heliaBtn = $('helia-btn');
const gwCheckBtn = $('gateway-check-btn');
const gwDlBtn = $('gateway-dl-btn');
const cancelBtn = $('cancel-btn');
const runControls = $('run-controls');
const statusLine = $('status-line');
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const gatewayTable = $('gateway-table');
const gatewayTbody = $('gateway-tbody');
const logEl = $('log');
const resultEl = $('result');
const downloadLink = $('download-link');
const resultInfo = $('result-info');

const GATEWAYS = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://trustless-gateway.link',
  'https://gateway.pinata.cloud',
  'https://4everland.io',
  'https://w3s.link',
  'https://ipfs.eth.aragon.network',
  'https://storry.tv',
];

// How long the Helia fetch keeps trying before giving up. Content discovery
// on IPFS can legitimately take minutes, so this is deliberately generous;
// the user can always cancel earlier.
const HELIA_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
const GATEWAY_PROBE_TIMEOUT_MS = 15 * 1000;
const CHUNK_SIZE = 1 << 20; // 1 MiB per range request

let abortController = null;
let running = false;
let lastObjectUrl = null;
let gatewayProbeResults = null; // results of the last "check gateways" run
let heliaPromise = null; // memoized Helia node, reused across fetches

// ---------- UI helpers ----------

function log(msg, cls) {
  logEl.classList.remove('hidden');
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
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
  running = true;
  abortController = new AbortController();
  runControls.classList.remove('hidden');
  resultEl.classList.add('hidden');
  progressWrap.classList.add('hidden');
  logEl.classList.add('hidden');
  logEl.textContent = '';
  heliaBtn.disabled = true;
  gwCheckBtn.disabled = true;
  gwDlBtn.disabled = true;
  setStatus(statusMsg);
  return abortController.signal;
}

function endRun() {
  running = false;
  runControls.classList.add('hidden');
  heliaBtn.disabled = false;
  gwCheckBtn.disabled = false;
  gwDlBtn.disabled = !gatewayProbeResults ||
    gatewayProbeResults.every((r) => !r.ok);
}

function formatBytes(n) {
  if (n == null) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function getCid() {
  const cid = cidInput.value.trim();
  if (!cid) {
    log('Please enter a CID first.', 'log-error');
    return null;
  }
  return cid;
}

function offerDownload(bytes, source) {
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  const blob = new Blob([bytes]);
  lastObjectUrl = URL.createObjectURL(blob);
  downloadLink.href = lastObjectUrl;
  downloadLink.download = filenameInput.value.trim() ||
    (cidInput.value.trim().slice(0, 16) + '.bin');
  resultInfo.textContent = `${formatBytes(blob.size)} · ${source}`;
  resultEl.classList.remove('hidden');
}

cancelBtn.addEventListener('click', () => {
  if (abortController) abortController.abort(new Error('cancelled by user'));
});

// ---------- Option 1: Helia (p2p) ----------

async function getHelia(signal) {
  if (!heliaPromise) {
    heliaPromise = (async () => {
      setStatus('Loading Helia libraries…');
      log('Loading Helia from esm.sh (first use only)…');
      const [{ createHelia }, { unixfs }, { CID }] = await Promise.all([
        import('https://esm.sh/helia@5'),
        import('https://esm.sh/@helia/unixfs@5'),
        import('https://esm.sh/multiformats@13/cid'),
      ]);
      setStatus('Starting IPFS node…');
      log('Starting in-browser IPFS node…');
      const helia = await createHelia();
      const fs = unixfs(helia);
      helia.libp2p.addEventListener('peer:connect', (evt) => {
        const n = helia.libp2p.getPeers().length;
        log(`Connected to peer ${evt.detail.toString().slice(-8)} (${n} peer${n === 1 ? '' : 's'} total)`);
      });
      log(`Node started. Peer ID: ${helia.libp2p.peerId.toString()}`);
      return { helia, fs, CID };
    })();
    heliaPromise.catch(() => { heliaPromise = null; });
  }
  signal.throwIfAborted();
  return heliaPromise;
}

async function heliaFetch() {
  const cidStr = getCid();
  if (!cidStr) return;
  const signal = startRun('Preparing Helia…');
  const startedAt = Date.now();

  // Periodic heartbeat so the user can see it is still working, not hung.
  let heliaRef = null;
  const heartbeat = setInterval(() => {
    if (!running) return;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const peers = heliaRef ? heliaRef.libp2p.getPeers().length : 0;
    setStatus(`Searching the network… ${elapsed}s elapsed, ${peers} peers connected`);
  }, 3000);

  try {
    const { helia, fs, CID } = await getHelia(signal);
    heliaRef = helia;

    let cid;
    try {
      cid = CID.parse(cidStr);
    } catch (err) {
      throw new Error(`"${cidStr}" is not a valid CID: ${err.message}`);
    }

    const timeoutSignal = AbortSignal.timeout(HELIA_TOTAL_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeoutSignal]);

    log(`Looking for ${cidStr} on the p2p network.`);
    log(`This can take a while for rare content — will keep trying for up to ${HELIA_TOTAL_TIMEOUT_MS / 60000} minutes. You can cancel at any time.`);
    setProgress(null, 'Discovering providers…');

    let stat = null;
    try {
      stat = await fs.stat(cid, { signal: combined });
      log(`Found it! Type: ${stat.type}, size: ${formatBytes(Number(stat.fileSize ?? stat.dagSize ?? 0) || null)}`);
    } catch (err) {
      if (combined.aborted) throw err;
      log('Could not stat the CID first, streaming it directly instead…', 'log-warn');
    }

    if (stat && stat.type === 'directory') {
      log('This CID is a directory. Listing its entries:', 'log-warn');
      for await (const entry of fs.ls(cid, { signal: combined })) {
        log(`  ${entry.name}  (${entry.cid.toString()})`);
      }
      log('Fetch one of the file CIDs above to download a file.', 'log-warn');
      setStatus('Done — directory listed');
      return;
    }

    const totalSize = stat ? Number(stat.fileSize ?? 0) || null : null;
    const chunks = [];
    let received = 0;
    let firstByteLogged = false;

    for await (const chunk of fs.cat(cid, { signal: combined })) {
      if (!firstByteLogged) {
        firstByteLogged = true;
        log(`First data received after ${Math.round((Date.now() - startedAt) / 1000)}s — downloading…`, 'log-ok');
      }
      chunks.push(chunk);
      received += chunk.length;
      if (totalSize) {
        setProgress(received / totalSize, `${formatBytes(received)} of ${formatBytes(totalSize)}`);
      } else {
        setProgress(null, `${formatBytes(received)} received`);
      }
    }

    const bytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }

    const took = Math.round((Date.now() - startedAt) / 1000);
    log(`Done: ${formatBytes(received)} in ${took}s, every block hash-verified.`, 'log-ok');
    setStatus('Done');
    setProgress(1, formatBytes(received));
    offerDownload(bytes, 'via Helia (verified)');
  } catch (err) {
    if (signal.aborted) {
      log('Cancelled.', 'log-warn');
      setStatus('Cancelled');
    } else if (err.name === 'TimeoutError' || /timed? ?out/i.test(err.message)) {
      log(`Gave up after ${HELIA_TOTAL_TIMEOUT_MS / 60000} minutes without finding the content. It may not be online right now — try the gateway option, or try again later.`, 'log-error');
      setStatus('Timed out');
    } else {
      log(`Error: ${err.message}`, 'log-error');
      setStatus('Failed');
    }
  } finally {
    clearInterval(heartbeat);
    endRun();
  }
}

// ---------- Option 2: public gateways ----------

function gatewayUrl(gw, cid) {
  return `${gw}/ipfs/${cid}`;
}

async function probeGateway(gw, cid, signal) {
  const result = { gw, ok: false, ranges: false, size: null, status: '…' };
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS)]);
  try {
    // Range probe: cheap (1 byte) and tells us whether ranged requests work,
    // which is what parallel downloading needs.
    const res = await fetch(gatewayUrl(gw, cid), {
      signal: probeSignal,
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    if (res.status === 206) {
      result.ok = true;
      result.ranges = true;
      const cr = res.headers.get('content-range');
      const m = cr && cr.match(/\/(\d+)$/);
      if (m) result.size = Number(m[1]);
      result.status = 'available';
    } else if (res.ok) {
      result.ok = true;
      const len = res.headers.get('content-length');
      if (len) result.size = Number(len);
      result.status = 'available (no ranges)';
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

function renderGatewayTable(results) {
  gatewayTable.classList.remove('hidden');
  gatewayTbody.textContent = '';
  for (const r of results) {
    const tr = document.createElement('tr');
    const cls = r.ok ? 'gw-ok' : 'gw-bad';
    tr.innerHTML =
      `<td>${new URL(r.gw).host}</td>` +
      `<td class="${cls}">${r.status}</td>` +
      `<td>${r.ranges ? 'yes' : 'no'}</td>` +
      `<td>${formatBytes(r.size)}</td>`;
    gatewayTbody.appendChild(tr);
  }
}

async function checkGateways() {
  const cid = getCid();
  if (!cid) return;
  const signal = startRun('Probing public gateways…');
  try {
    log(`Asking ${GATEWAYS.length} public gateways about ${cid}…`);
    const results = await Promise.all(GATEWAYS.map((gw) => probeGateway(gw, cid, signal)));
    gatewayProbeResults = results;
    renderGatewayTable(results);
    const ok = results.filter((r) => r.ok);
    if (ok.length === 0) {
      log('No gateway can currently serve this CID.', 'log-error');
      setStatus('Not found on gateways');
    } else {
      log(`${ok.length} of ${GATEWAYS.length} gateways can serve this CID.`, 'log-ok');
      setStatus(`${ok.length} gateways available`);
    }
  } catch (err) {
    log(signal.aborted ? 'Cancelled.' : `Error: ${err.message}`, 'log-warn');
    setStatus(signal.aborted ? 'Cancelled' : 'Failed');
  } finally {
    endRun();
  }
}

async function fetchChunk(gw, cid, start, end, signal) {
  const res = await fetch(gatewayUrl(gw, cid), {
    signal,
    headers: { Range: `bytes=${start}-${end}` },
    cache: 'no-store',
  });
  if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== end - start + 1) throw new Error('short read');
  return buf;
}

async function downloadViaGateways() {
  const cid = getCid();
  if (!cid) return;
  const signal = startRun('Preparing gateway download…');
  try {
    // Re-probe if we have no fresh results for this run.
    if (!gatewayProbeResults) {
      log('Probing gateways first…');
      gatewayProbeResults = await Promise.all(GATEWAYS.map((gw) => probeGateway(gw, cid, signal)));
      renderGatewayTable(gatewayProbeResults);
    }
    const usable = gatewayProbeResults.filter((r) => r.ok);
    if (usable.length === 0) throw new Error('no gateway can serve this CID');

    const ranged = usable.filter((r) => r.ranges && r.size != null);
    const sizes = new Set(ranged.map((r) => r.size));
    const size = ranged.length ? ranged[0].size : null;

    // Parallel multi-gateway download needs: ≥2 range-capable gateways that
    // agree on the file size, and a file big enough to be worth splitting.
    if (ranged.length >= 2 && sizes.size === 1 && size > CHUNK_SIZE * 2) {
      const sources = ranged.map((r) => r.gw);
      log(`Downloading ${formatBytes(size)} in parallel from ${sources.length} gateways: ${sources.map((g) => new URL(g).host).join(', ')}`, 'log-ok');

      const nChunks = Math.ceil(size / CHUNK_SIZE);
      const parts = new Array(nChunks);
      let next = 0;
      let done = 0;
      const perGateway = new Map(sources.map((g) => [g, 0]));

      const worker = async (gw) => {
        while (!signal.aborted) {
          const i = next++;
          if (i >= nChunks) return;
          const start = i * CHUNK_SIZE;
          const end = Math.min(size, start + CHUNK_SIZE) - 1;
          try {
            parts[i] = await fetchChunk(gw, cid, start, end, signal);
            perGateway.set(gw, perGateway.get(gw) + 1);
          } catch (err) {
            if (signal.aborted) throw err;
            // This gateway failed the chunk — put it back on the queue for
            // the others and retire this worker.
            log(`${new URL(gw).host} failed a chunk (${err.message}); other gateways will pick it up.`, 'log-warn');
            next = Math.min(next, i);
            return;
          }
          done++;
          setProgress(done / nChunks, `${formatBytes(done * CHUNK_SIZE > size ? size : done * CHUNK_SIZE)} of ${formatBytes(size)}`);
        }
      };

      await Promise.all(sources.map(worker));
      signal.throwIfAborted();

      // Any chunks a retired worker left behind get a sequential second pass.
      for (let i = 0; i < nChunks; i++) {
        if (parts[i]) continue;
        const start = i * CHUNK_SIZE;
        const end = Math.min(size, start + CHUNK_SIZE) - 1;
        let fetched = false;
        for (const gw of sources) {
          try {
            parts[i] = await fetchChunk(gw, cid, start, end, signal);
            fetched = true;
            break;
          } catch { /* try next gateway */ }
        }
        if (!fetched) throw new Error(`could not fetch bytes ${start}-${end} from any gateway`);
      }

      const bytes = new Uint8Array(size);
      let off = 0;
      for (const p of parts) { bytes.set(p, off); off += p.length; }

      const summary = [...perGateway.entries()]
        .filter(([, n]) => n > 0)
        .map(([g, n]) => `${new URL(g).host}: ${n} chunks`)
        .join(', ');
      log(`Done. Chunk distribution — ${summary}`, 'log-ok');
      setStatus('Done');
      offerDownload(bytes, `via ${sources.length} gateways (unverified)`);
    } else {
      // Fall back to a single-gateway streaming download.
      const gw = (ranged[0] ?? usable[0]).gw;
      const reason =
        ranged.length >= 2 && sizes.size === 1 ? 'file is small — one gateway is fastest' :
        ranged.length >= 2 ? 'gateways disagree on the file size' :
        ranged.length === 1 ? 'only one gateway supports range requests' :
        'no gateway supports range requests';
      log(`Downloading from a single gateway: ${new URL(gw).host} (${reason})`);
      const res = await fetch(gatewayUrl(gw, cid), { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(gw).host}`);
      const total = Number(res.headers.get('content-length')) || null;
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
      const bytes = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) { bytes.set(c, off); off += c.length; }
      log(`Done: ${formatBytes(received)}.`, 'log-ok');
      setStatus('Done');
      offerDownload(bytes, `via ${new URL(gw).host} (unverified)`);
    }
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

// Probe results are per-CID; invalidate them when the CID changes.
cidInput.addEventListener('input', () => {
  gatewayProbeResults = null;
  gwDlBtn.disabled = true;
  gatewayTable.classList.add('hidden');
});

heliaBtn.addEventListener('click', heliaFetch);
gwCheckBtn.addEventListener('click', checkGateways);
gwDlBtn.addEventListener('click', downloadViaGateways);

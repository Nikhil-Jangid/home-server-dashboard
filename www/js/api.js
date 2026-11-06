// Glances /api/4/all client: pure parsing plus a small poller. No DOM access.

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const arr = x => (Array.isArray(x) ? x.filter(e => e && typeof e === 'object') : []);
// Loopback, container bridges, VPN tunnels and the kernel's tunnel stubs (gre0, sit0 ...) are not adapters.
const VIRTUAL_IF = /^(lo$|docker|br-|veth|tun|tailscale|gre|gretap|erspan|ip6?_vti|ip6?tnl|ip6gre|sit\d)/;

// Mounts that are never "storage" to a person: boot partitions, snaps, container layers, runtime dirs.
const PSEUDO_MNT = /^\/(boot|snap|run|dev|sys|proc)(\/|$)|^\/var\/lib\/(docker|containers)\//;
const PSEUDO_FS = new Set(['squashfs', 'overlay', 'tmpfs', 'devtmpfs', 'ramfs', 'efivarfs', 'nsfs', 'autofs']);

function parseFs(f) {
  const size = num(f.size), used = num(f.used);
  return {
    mnt: f.mnt_point || f.mountpoint || '?',
    dev: String(f.device_name || ''),
    type: String(f.fs_type || '').toLowerCase(),
    size, used, free: num(f.free),
    pct: f.percent != null ? num(f.percent) : size ? (used / size) * 100 : 0
  };
}

/** Real filesystems only, each mount once, "/" first then by mount path. */
function storageList(fs) {
  const seen = new Set();
  return fs.filter(f => !PSEUDO_MNT.test(f.mnt) && !PSEUDO_FS.has(f.type) && !seen.has(f.mnt) && seen.add(f.mnt))
    .sort((a, b) => (a.mnt === '/' ? -1 : b.mnt === '/' ? 1 : a.mnt < b.mnt ? -1 : a.mnt > b.mnt ? 1 : 0));
}

/** Used/size across distinct devices, so a bind mount of the same disk is counted once. */
function storageTotal(list) {
  const byDev = new Map();
  for (const f of list) { const k = f.dev || f.mnt; if (!byDev.has(k)) byDev.set(k, f); }
  const size = [...byDev.values()].reduce((s, f) => s + f.size, 0);
  const used = [...byDev.values()].reduce((s, f) => s + f.used, 0);
  return { size, used, pct: size ? (used / size) * 100 : null };
}

export function parseGlances(d) {
  d = d || {};
  const mem = d.mem || {};
  const memPct = mem.total ? (num(mem.used) / num(mem.total)) * 100 : 0;
  const fsList = storageList(arr(d.fs).map(parseFs));
  const stor = storageTotal(fsList);

  const physical = arr(d.network).filter(n => !VIRTUAL_IF.test(n.interface_name || n.name || ''));
  const rx = physical.reduce((s, n) => s + num(n.bytes_recv_rate_per_sec), 0);
  const tx = physical.reduce((s, n) => s + num(n.bytes_sent_rate_per_sec), 0);

  const temps = arr(d.sensors).filter(s => s.unit === 'C');
  const pkg = temps.find(s => /package|pkg/i.test(s.label || '')) || temps.find(s => /core 0/i.test(s.label || '')) || temps[0];
  const hottest = temps.reduce((m, s) => (m == null || num(s.value) > num(m.value) ? s : m), null);

  const containers = arr(d.containers).map(c => ({
    name: String(c.name || '').replace(/^\//, ''),
    id: typeof c.id === 'string' ? c.id.slice(0, 64) : '',
    status: String(c.status || 'unknown').toLowerCase(),
    image: Array.isArray(c.image) ? String(c.image[0] ?? '—') : String(c.image || '—'),
    cpu: num(c.cpu?.total ?? c.cpu_percent),
    mem: num(c.memory?.usage ?? c.memory_usage),
    uptime: c.uptime ? String(c.uptime) : '—',
    ports: Array.isArray(c.ports) ? c.ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 8) : []
  }));

  return {
    cpu: num(d.cpu?.total),
    memPct,
    mem: { used: num(mem.used), total: num(mem.total), available: mem.available != null ? num(mem.available) : null },
    swapPct: d.memswap && d.memswap.total ? num(d.memswap.percent) : null,
    load: d.load ? [num(d.load.min1), num(d.load.min5), num(d.load.min15)] : null,
    proc: d.processcount ? { total: num(d.processcount.total), running: num(d.processcount.running) } : null,
    uptime: d.uptime ? String(d.uptime) : null,
    fsList, storPct: stor.pct, storSize: stor.size, storUsed: stor.used,
    gpus: arr(d.gpu).map(g => ({ name: String(g.name || 'GPU'), util: g.proc != null ? num(g.proc) : null, mem: g.mem != null ? num(g.mem) : null, temp: g.temperature != null ? num(g.temperature) : null })),
    rx, tx, nets: physical.map(n => n.interface_name || n.name),
    temp: pkg ? num(pkg.value) : null,
    maxTemp: hottest ? num(hottest.value) : null,
    maxTempLabel: hottest ? String(hottest.label || 'sensor') : null,
    containers
  };
}

/**
 * Polls `url` every `intervalMs`. With `retryDelay(attempt)` the poller instead schedules each poll after the
 * previous one ends: `intervalMs` after a success, `retryDelay(0)`, `retryDelay(1)`, ... after failures.
 */
export function createPoller({
  url, intervalMs, timeoutMs = 4500, fetchImpl = (...a) => fetch(...a), onData, onError,
  retryDelay = null, setT = (fn, ms) => setTimeout(fn, ms), clearT = id => clearTimeout(id)
}) {
  let timer = null;
  let current = null; // the in-flight poll: { ctrl, stopped, promise }
  let started = false, fails = 0; // retryDelay mode only

  function reschedule(ok) {
    if (!retryDelay) return;
    fails = ok ? 0 : fails + 1;
    if (!started) return;
    if (timer !== null) clearT(timer);
    timer = setT(tick, ok ? intervalMs : retryDelay(fails - 1));
  }
  function tick() { timer = null; pollNow(); }

  async function run(job) {
    const { ctrl } = job;
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    // an abort is a timeout unless stop() caused it, in which case nothing is reported
    const aborted = e => (e && e.name === 'AbortError') || ctrl.signal.aborted;
    let outcome = null; // 'ok' | 'error' once reported
    const fail = e => { outcome = 'error'; onError(e); };
    try {
      let res;
      try {
        res = await fetchImpl(url, { signal: ctrl.signal, cache: 'no-store' });
      } catch (e) {
        if (!job.stopped) fail({ kind: aborted(e) ? 'timeout' : 'network', message: String(e.message || e) });
        return;
      }
      if (job.stopped) return;
      if (!res.ok) { fail({ kind: 'http', message: `HTTP ${res.status} ${res.statusText || ''}`.trim() }); return; }
      let data;
      try { data = await res.json(); } catch (e) {
        if (!job.stopped) fail({ kind: aborted(e) ? 'timeout' : 'parse', message: String(e.message || e) });
        return;
      }
      if (!job.stopped) { outcome = 'ok'; onData(data); }
    } finally {
      clearTimeout(to);
      if (current === job) current = null;
      if (outcome && !job.stopped) reschedule(outcome === 'ok');
    }
  }

  // A poll while another is in flight joins it instead of starting a second request.
  function pollNow() {
    if (current) return current.promise;
    const job = { ctrl: new AbortController(), stopped: false, promise: null };
    current = job;
    job.promise = run(job);
    return job.promise;
  }

  return {
    pollNow,
    start() {
      if (retryDelay) { if (!started) { started = true; if (timer === null) timer = setT(tick, intervalMs); } }
      else if (!timer) timer = setInterval(pollNow, intervalMs);
    },
    stop() {
      if (retryDelay) { started = false; if (timer !== null) clearT(timer); } else clearInterval(timer);
      timer = null;
      if (current) { current.stopped = true; current.ctrl.abort(); current = null; }
    },
    get running() { return retryDelay ? started : timer !== null; }
  };
}

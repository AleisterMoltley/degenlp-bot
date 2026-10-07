import express from "express";
import { config } from "./config.js";
import { getBot } from "./runtime.js";

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!config.dashboardPassword) return next();

  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Degen LP Bot"');
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user === config.dashboardUser && pass === config.dashboardPassword) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Degen LP Bot"');
  return res.status(401).send("Invalid credentials");
}

export function createServer() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  app.get("/api/status", authMiddleware, (_req, res) => {
    res.json(getBot().getSnapshot());
  });

  app.post("/api/pause", authMiddleware, (_req, res) => {
    getBot().pause();
    res.json({ ok: true, paused: true });
  });

  app.post("/api/resume", authMiddleware, (_req, res) => {
    getBot().resume();
    res.json({ ok: true, paused: false });
  });

  app.post("/api/scan", authMiddleware, async (_req, res) => {
    try {
      const check = await getBot().scanOnce();
      res.json({ ok: true, check });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.get("/", authMiddleware, (_req, res) => {
    res.type("html").send(dashboardHtml());
  });

  return app;
}

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Degen LP</title>
  <style>
    :root {
      --bg: #070b0a;
      --panel: #0f1614;
      --border: #1e2e28;
      --text: #e8fff4;
      --muted: #7fa393;
      --accent: #3dff9a;
      --warn: #ffcc66;
      --danger: #ff6b6b;
      --blue: #5eb8ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #123528 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 4px; font-size: 1.6rem; letter-spacing: -0.02em; }
    .sub { color: var(--muted); margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
    }
    .label { color: var(--muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .value { font-size: 1.35rem; font-weight: 700; margin-top: 6px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
    }
    .ok { background: #153a2a; color: var(--accent); }
    .warn { background: #3a3115; color: var(--warn); }
    .danger { background: #3a1515; color: var(--danger); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
    button {
      background: #13241d;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 600;
    }
    button.primary { background: #154a33; border-color: #2f7d57; color: var(--accent); }
    button:hover { filter: brightness(1.08); }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    .section { margin-top: 18px; }
    .err { color: var(--danger); white-space: pre-wrap; }
    @media (max-width: 700px) { .wrap { padding: 14px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Degen LP</h1>
    <p class="sub">Paper growth desk. It compounds a 1 SOL bankroll into the pool with the best edge after costs. The week target is 30 SOL. A seat is cut when it gives back 12% of its size. The path is not a promise.</p>

    <div class="actions">
      <button class="primary" onclick="scanNow()">Scan now</button>
      <button onclick="pauseBot()">Pause</button>
      <button onclick="resumeBot()">Resume</button>
      <button onclick="refresh()">Refresh</button>
    </div>

    <div class="grid" id="stats"></div>

    <div class="section card">
      <div class="label">Last scan</div>
      <div id="lastScan" style="margin-top:10px"></div>
    </div>

    <div class="section card">
      <div class="label">Active position</div>
      <div id="position" style="margin-top:10px"></div>
    </div>

    <div class="section card">
      <div class="label">Scalp gate</div>
      <div id="candidates" style="margin-top:10px"></div>
    </div>

    <div class="section card">
      <div class="label">Scan history</div>
      <div id="history" style="margin-top:10px"></div>
    </div>

    <div class="section card" id="errorBox" style="display:none">
      <div class="label">Last error</div>
      <div class="err" id="errorText"></div>
    </div>
  </div>

  <script>
    function openNet(s) {
      const p = s.activePosition;
      if (!p) return 0;
      return (p.feesAccruedUsd||0) - (p.ilUsd||0) - (p.costsUsd||0);
    }
    function badge(text, cls) { return '<span class="badge ' + cls + '">' + text + '</span>'; }
    function fmt(n, d=3) { return Number(n||0).toFixed(d); }
    function esc(s) { return String(s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

    async function api(path, method='GET') {
      const res = await fetch(path, { method, credentials: 'same-origin' });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function renderStatus(s) {
      const mode = s.config.dryRun ? badge('DRY RUN', 'warn') : badge('LIVE', 'danger');
      const run = s.paused ? badge('PAUSED', 'warn') : badge('RUNNING', 'ok');
      const wallet = s.config.walletConfigured ? badge('WALLET OK', 'ok') : badge('NO WALLET', 'warn');

      document.getElementById('stats').innerHTML = [
        ['Status', run],
        ['Mode', mode],
        ['Wallet', wallet],
        ['Uptime', Math.floor(s.uptimeSec/60) + 'm'],
        ['Scans', String(s.scanCount)],
        ['Scan', (s.scanMs || 0) + ' ms'],
        ['Interval', (s.config.scanIntervalMs/1000) + 's'],
        ['Pools', (s.poolCounts ? (s.poolCounts.dlmm + '/' + s.poolCounts.damm_v2 + '/' + s.poolCounts.damm_v1) : '—')],
        ['Equity', s.growth ? fmt(s.growth.equitySol, 3) + ' SOL' : '—'],
        ['Pace', s.growth ? fmt(s.growth.paceSol, 3) + ' SOL' : '—'],
        ['Target', s.growth ? s.growth.targetSol + ' SOL' : '—'],
        ['Deploy', s.growth ? fmt(s.growth.deploySol, 3) + ' SOL' : (s.config.solDeploy + ' SOL')],
        ['Realized', '$' + fmt(s.book?.realizedUsd, 4)],
        ['Open', '$' + fmt(openNet(s), 4)],
      ].map(([k,v]) => '<div class="card"><div class="label">' + k + '</div><div class="value">' + v + '</div></div>').join('');

      const ls = s.lastScan;
      document.getElementById('lastScan').innerHTML = ls ? (
        '<div><strong>' + esc(ls.decision.toUpperCase()) + '</strong> · ' + esc(ls.poolName) + '</div>' +
        '<div class="mono" style="margin-top:6px;color:var(--muted)">' +
        esc(ls.venue || 'n/a') + ' · ' + esc(ls.reason || '') +
        ' · edge $' + fmt(ls.opportunityScore, 3) + ' · fee/tvl ' + fmt(ls.feeToTvlRatio, 4)
        '</div><div class="mono" style="margin-top:4px;color:var(--muted)">' + esc(s.lastScanAt||'') + '</div>'
      ) : '<span style="color:var(--muted)">No scans yet</span>';

      const p = s.activePosition;
      document.getElementById('position').innerHTML = p ? (
        '<div><strong>' + esc(p.venue) + ' ' + esc(p.poolName) + '</strong> (' + esc(p.id) + ' · ' + esc(p.side) + ')</div>' +
        '<div class="mono" style="margin-top:6px;color:var(--muted)">' +
        esc(p.solDeployed) + ' SOL · fees $' + fmt(p.feesAccruedUsd, 4) +
        ' · divergence $' + fmt(p.ilUsd, 4) + ' · costs $' + fmt(p.costsUsd, 4) +
        ' · after exit $' + fmt((p.feesAccruedUsd||0) - (p.ilUsd||0) - (p.costsUsd||0) - 0.02, 4) + '<br>' +
        'pool ' + esc(p.poolAddress) +
        '</div>'
      ) : '<span style="color:var(--muted)">No active position</span>';

      const hist = s.scanHistory?.[0]?.topCandidates || [];
      document.getElementById('candidates').innerHTML = hist.length ? (
        '<table><thead><tr><th>Pool</th><th>Venue</th><th>Shape</th><th>Edge after costs</th><th>Fee 30m</th><th>Gate</th></tr></thead><tbody>' +
        hist.map(c => '<tr><td>' + esc(c.poolName) + '</td><td>' + esc(c.venue) +
        '</td><td>' + esc(c.side || '') +
        '</td><td>$' + fmt(c.edgeUsd, 3) + '</td><td>$' + fmt(c.fee30m, 0) +
        '</td><td>' + (c.metThreshold ? badge('PASS','ok') : badge('SKIP','warn')) + '</td></tr>').join('') +
        '</tbody></table>'
      ) : '<span style="color:var(--muted)">—</span>';

      document.getElementById('history').innerHTML = (s.scanHistory||[]).slice(0,12).map(h =>
        '<div style="padding:8px 0;border-bottom:1px solid var(--border)">' +
        '<span class="mono" style="color:var(--muted)">' + esc(h.at) + '</span> · ' +
        '<strong>' + esc(h.check.decision) + '</strong> · ' + esc(h.check.poolName) +
        ' · ' + esc(h.check.reason || '') +
        '</div>'
      ).join('') || '<span style="color:var(--muted)">—</span>';

      const errBox = document.getElementById('errorBox');
      if (s.lastError) {
        errBox.style.display = 'block';
        document.getElementById('errorText').textContent = s.lastError;
      } else errBox.style.display = 'none';
    }

    async function refresh() {
      const s = await api('/api/status');
      renderStatus(s);
    }
    async function pauseBot() { await api('/api/pause', 'POST'); await refresh(); }
    async function resumeBot() { await api('/api/resume', 'POST'); await refresh(); }
    async function scanNow() { await api('/api/scan', 'POST'); await refresh(); }

    refresh().catch((err) => { document.getElementById('errorText').textContent = err.message; document.getElementById('errorBox').style.display = 'block'; });
    setInterval(() => refresh().catch(() => {}), 4000);
  </script>
</body>
</html>`;
}

export function startServer() {
  const app = createServer();
  app.listen(config.port, () => {
    console.log(`Dashboard listening on :${config.port}`);
    if (!config.dashboardPassword) {
      console.warn("WARNING: DASHBOARD_PASSWORD not set — dashboard is open to anyone");
    }
  });
  return app;
}
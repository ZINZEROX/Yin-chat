const express = require("express");
const fetch   = require("node-fetch");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── STORAGE ────────────────────────────────────────────────────────────────
const MAX_MESSAGES = 50;
const ONLINE_TTL   = 300; // seconds — 5 minutes

let messages      = [];
let msgIdCounter  = 0;
let onlineSeen    = {}; // playerId → unix timestamp last seen
let profiles      = {}; // playerId → { playerName, description, imageId }
let pendingKeys   = {}; // username → { key, generatedAt, ip } — set by LootLabs postback

function cleanOnline() {
    const cutoff = Math.floor(Date.now() / 1000) - ONLINE_TTL;
    for (const id in onlineSeen) {
        if (onlineSeen[id] < cutoff) delete onlineSeen[id];
    }
}

function getOnlineCount() {
    cleanOnline();
    return Object.keys(onlineSeen).length;
}

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// ─── POST /api/chat/send ─────────────────────────────────────────────────────
app.post("/api/chat/send", (req, res) => {
    const { playerName, playerId, message } = req.body || {};

    if (!playerName || !playerId || !message) {
        return res.json({ success: false, error: "missing fields" });
    }

    const now = Math.floor(Date.now() / 1000);

    // Track online
    onlineSeen[String(playerId)] = now;

    // Store message
    msgIdCounter++;
    messages.push({
        id:         msgIdCounter,
        playerName: String(playerName),
        playerId:   String(playerId),
        message:    String(message),
        timestamp:  now,
    });

    // Keep only last 50
    if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(messages.length - MAX_MESSAGES);
    }

    console.log(`[ChatGlobal] New message from ${playerName} (${playerId}): ${message}`);

    res.json({ success: true });
});

// ─── GET /api/chat/messages ──────────────────────────────────────────────────
app.get("/api/chat/messages", (req, res) => {
    res.json({
        messages:    messages, // already oldest → newest
        onlineCount: getOnlineCount(),
    });
});

// ─── POST /api/heartbeat ─────────────────────────────────────────────────────
app.post("/api/heartbeat", (req, res) => {
    const { playerId } = req.body || {};
    if (!playerId) return res.json({ ok: false, error: "missing playerId" });
    onlineSeen[String(playerId)] = Math.floor(Date.now() / 1000);
    res.json({ ok: true });
});

// ─── POST /api/translate ─────────────────────────────────────────────────────
app.post("/api/translate", async (req, res) => {
    const { text, to } = req.body || {};

    if (!text || !to) {
        return res.json({ success: false, error: "missing fields" });
    }

    try {
        const encoded  = encodeURIComponent(text);
        const url      = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=auto|${to}`;
        const response = await fetch(url);
        const data     = await response.json();

        const translated = data?.responseData?.translatedText;
        const from       = data?.matches?.[0]?.source_segment_language || "auto";

        if (!translated) {
            return res.json({ success: false, error: "empty translation" });
        }

        res.json({
            success:    true,
            translated: translated,
            from:       from,
            to:         to,
        });
    } catch (err) {
        console.warn("[ChatGlobal] Translation error:", err.message);
        res.json({ success: false, error: err.message });
    }
});

// ─── POST /api/profile/save ──────────────────────────────────────────────────
app.post("/api/profile/save", (req, res) => {
    const { playerId, playerName, description, imageId } = req.body || {};

    if (!playerId) {
        return res.json({ success: false, error: "missing playerId" });
    }

    profiles[String(playerId)] = {
        playerName:  String(playerName  || ""),
        description: String(description || ""),
        imageId:     String(imageId     || ""),
    };

    console.log(`[Profile] Saved profile for ${playerId}`);
    res.json({ success: true });
});

// ─── GET /api/profile/:playerId ──────────────────────────────────────────────
app.get("/api/profile/:playerId", (req, res) => {
    const profile = profiles[String(req.params.playerId)];

    if (!profile) {
        return res.json({ success: false, error: "profile not found" });
    }

    res.json({ success: true, profile });
});

// ─── BUILDER STORAGE ────────────────────────────────────────────────────────
const MAX_PARTS  = 500;
let builderParts = [];   // { id, shape, x, y, z, sx, sy, sz, rx, ry, rz, r, g, b, material, placedBy }
let partIdCounter = 0;

// ─── POST /api/builder/place ─────────────────────────────────────────────────
app.post("/api/builder/place", (req, res) => {
    const { shape, x, y, z, sx, sy, sz, rx, ry, rz, r, g, b, material, placedBy } = req.body || {};

    if (x === undefined || y === undefined || z === undefined) {
        return res.json({ success: false, error: "missing position" });
    }

    partIdCounter++;
    const part = {
        id:        partIdCounter,
        shape:     String(shape     || "Part"),
        x:         Number(x),
        y:         Number(y),
        z:         Number(z),
        sx:        Number(sx        || 4),
        sy:        Number(sy        || 1),
        sz:        Number(sz        || 4),
        rx:        Number(rx        || 0),
        ry:        Number(ry        || 0),
        rz:        Number(rz        || 0),
        r:         Number(r         || 163),
        g:         Number(g         || 162),
        b:         Number(b         || 165),
        material:  String(material  || "SmoothPlastic"),
        placedBy:  String(placedBy  || "unknown"),
        timestamp: Math.floor(Date.now() / 1000),
    };

    builderParts.push(part);

    if (builderParts.length > MAX_PARTS) {
        builderParts = builderParts.slice(builderParts.length - MAX_PARTS);
    }

    console.log(`[Builder] Part placed by ${part.placedBy} at (${part.x}, ${part.y}, ${part.z})`);
    res.json({ success: true, id: part.id });
});

// ─── POST /api/builder/delete ────────────────────────────────────────────────
app.post("/api/builder/delete", (req, res) => {
    const { id } = req.body || {};

    if (!id) return res.json({ success: false, error: "missing id" });

    const before = builderParts.length;
    builderParts = builderParts.filter(p => p.id !== Number(id));

    if (builderParts.length < before) {
        console.log(`[Builder] Part ${id} deleted`);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: "part not found" });
    }
});

// ─── GET /api/builder/parts ──────────────────────────────────────────────────
app.get("/api/builder/parts", (req, res) => {
    res.json({ success: true, parts: builderParts });
});

// ─── POST /api/builder/clear ─────────────────────────────────────────────────
// Limpia todas las partes (útil para empezar una sesión nueva)
app.post("/api/builder/clear", (req, res) => {
    const { confirm } = req.body || {};
    if (confirm !== "yes") return res.json({ success: false, error: "send confirm: yes" });
    builderParts = [];
    console.log("[Builder] All parts cleared");
    res.json({ success: true });
});

// ─── GET /api/key/postback ────────────────────────────────────────────────────
// Called by LootLabs when user completes tasks.
// Params: click_id (username), ip, unique_id
app.get("/api/key/postback", (req, res) => {
    const { click_id, ip, unique_id } = req.query;

    if (!click_id) {
        console.warn("[KeySystem] Postback received without click_id");
        return res.sendStatus(400);
    }

    // Generate key: YY- + 12 random hex chars
    const key = "YY-" + Array.from({ length: 12 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join("");

    pendingKeys[String(click_id).toLowerCase()] = {
        key,
        generatedAt: Math.floor(Date.now() / 1000),
        ip: ip || "unknown",
    };

    console.log(`[KeySystem] Key generated for "${click_id}" — ${key} (ip: ${ip})`);
    res.sendStatus(200);
});

// ─── GET /api/key/claim ───────────────────────────────────────────────────────
// Called by the Lua script after the user completes LootLabs.
// Param: username
app.get("/api/key/claim", (req, res) => {
    const { username } = req.query;

    if (!username) {
        return res.json({ success: false, error: "missing username" });
    }

    const entry = pendingKeys[String(username).toLowerCase()];

    if (!entry) {
        return res.json({ success: false, error: "no key found — complete LootLabs first" });
    }

    // Key expires after 10 minutes if not claimed
    const age = Math.floor(Date.now() / 1000) - entry.generatedAt;
    if (age > 600) {
        delete pendingKeys[String(username).toLowerCase()];
        return res.json({ success: false, error: "key expired — complete LootLabs again" });
    }

    console.log(`[KeySystem] Key claimed by "${username}" — ${entry.key}`);
    res.json({ success: true, key: entry.key });
});

// ─── GET /api/key/validate ────────────────────────────────────────────────────
// Called by the Lua script to validate if a stored key is still valid.
// Params: username, key
app.get("/api/key/validate", (req, res) => {
    const { username, key } = req.query;

    if (!username || !key) {
        return res.json({ success: false, error: "missing username or key" });
    }

    const entry = pendingKeys[String(username).toLowerCase()];

    if (!entry) {
        return res.json({ success: false, error: "no pending key found — complete LootLabs first" });
    }

    // Key expires after 24 hours from generation
    const age = Math.floor(Date.now() / 1000) - entry.generatedAt;
    if (age > 86400) { // 86400 seconds = 24 hours
        delete pendingKeys[String(username).toLowerCase()];
        return res.json({ success: false, error: "key expired — complete LootLabs again" });
    }

    // Verify the key matches
    if (entry.key !== String(key)) {
        return res.json({ success: false, error: "invalid key" });
    }

    console.log(`[KeySystem] Key validated for "${username}" — valid for ${Math.floor((86400 - age) / 3600)} more hours`);
    res.json({ 
        success: true, 
        key: entry.key,
        expiresIn: 86400 - age, // seconds until expiration
        expiresAt: entry.generatedAt + 86400 // unix timestamp of expiration
    });
});

// ─── GET /key ────────────────────────────────────────────────────────────────
// Redirect destino de LootLabs. Genera la key al llegar y la muestra al instante.
// LootLabs redirect URL: https://yin-chat-production.up.railway.app/key?click_id={CLICK_ID}
app.get("/key", (req, res) => {
    const { click_id } = req.query;
    if (!click_id) return res.send("<h2>Error: falta click_id</h2>");

    const username = String(click_id).toLowerCase();
    const now      = Math.floor(Date.now() / 1000);

    // Si ya tiene una key válida (no expirada), reutilizarla
    let entry = pendingKeys[username];
    if (!entry || (now - entry.generatedAt) > 86400) {
        const key = "YY-" + Array.from({ length: 12 }, () =>
            Math.floor(Math.random() * 16).toString(16)
        ).join("");
        entry = { key, generatedAt: now, ip: req.ip || "unknown" };
        pendingKeys[username] = entry;
        console.log(`[KeySystem] Key generada en /key para "${click_id}" — ${entry.key}`);
    } else {
        console.log(`[KeySystem] Key reutilizada en /key para "${click_id}" — ${entry.key}`);
    }

    const key = entry.key;

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tu Key — Yin Yang Beta</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f0f13;
    color: #e8e8f0;
    font-family: 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
  }
  .card {
    background: #1a1a24;
    border: 1px solid #2e2e42;
    border-radius: 16px;
    padding: 36px 32px;
    max-width: 420px;
    width: 100%;
    text-align: center;
  }
  .logo { font-size: 32px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin-bottom: 6px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 28px; }
  .key-box {
    background: #0f0f13;
    border: 1px solid #3a3a55;
    border-radius: 10px;
    padding: 14px 18px;
    font-family: monospace;
    font-size: 18px;
    letter-spacing: 2px;
    color: #a78bfa;
    margin-bottom: 16px;
    word-break: break-all;
  }
  .status {
    font-size: 13px;
    color: #888;
    margin-bottom: 24px;
    min-height: 20px;
  }
  .status.ok  { color: #4ade80; }
  .status.err { color: #f87171; }
  .btn {
    display: inline-block;
    padding: 12px 28px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    margin: 6px;
    text-decoration: none;
  }
  .btn-copy   { background: #7c3aed; color: #fff; }
  .btn-copy:hover { background: #6d28d9; }
  .btn-dc     { background: #5865f2; color: #fff; }
  .btn-dc:hover { background: #4752c4; }
  .spinner { color: #a78bfa; margin-bottom: 8px; font-size: 22px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">☯️</div>
  <h1>Yin Yang Beta</h1>
  <p class="sub">Tu key de acceso a los emotes</p>

  <div class="spinner" id="spinner">⏳ Obteniendo tu key...</div>
  <div class="key-box" id="keyBox" style="display:none">—</div>
  <div class="status" id="status"></div>

  <button class="btn btn-copy" id="copyBtn" style="display:none" onclick="copyKey()">📋 Copiar key</button>
  <br>
  <a class="btn btn-dc" href="https://discord.gg/TU_INVITE" target="_blank">💬 Ir al Discord</a>
</div>

<script>
  let currentKey = "";

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(currentKey);
      document.getElementById("status").textContent = "✅ Copiada al portapapeles";
      document.getElementById("status").className = "status ok";
    } catch(e) {
      document.getElementById("status").textContent = "Copia manual: selecciona el texto de arriba";
      document.getElementById("status").className = "status";
    }
  }

  (async () => {
    const key = "${key}";
    document.getElementById("spinner").style.display = "none";
    document.getElementById("keyBox").textContent = key;
    document.getElementById("keyBox").style.display = "block";
    document.getElementById("copyBtn").style.display = "inline-block";
    currentKey = key;

    try {
      await navigator.clipboard.writeText(key);
      document.getElementById("status").textContent = "✅ Key copiada automáticamente al portapapeles";
      document.getElementById("status").className = "status ok";
    } catch(e) {
      document.getElementById("status").textContent = "Presioná el botón para copiarla.";
    }
  })();
</script>
</body>
</html>`);
});

// ─── AI CHAT ───────────────────────────────────────────────────────────────────
const AI_NAME = process.env.AI_NAME || "Yin AI";
const AI_MODEL = process.env.AI_MODEL || "openai/gpt-oss-20b";
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
    "Eres la IA de Yin Yang. Responde de forma directa, útil y concisa.";

const AI_PROVIDERS = [
    {
        name: "Groq",
        key: "GROQ_API_KEY",
        url: "https://api.groq.com/openai/v1/chat/completions",
        model: process.env.GROQ_MODEL || AI_MODEL,
    },
    {
        name: "OpenRouter",
        key: "OPENROUTER_API_KEY",
        url: "https://openrouter.ai/api/v1/chat/completions",
        model: process.env.OPENROUTER_MODEL || "openai/gpt-oss-20b:free",
    },
    {
        name: "Gemini",
        key: "GEMINI_API_KEY",
        url: "https://generativelanguage.googleapis.com/v1beta/models/",
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    },
];

function getConfiguredAIProviders() {
    return AI_PROVIDERS.filter(provider => Boolean(process.env[provider.key]));
}

async function requestOpenAICompatibleProvider(provider, messages) {
    const response = await fetch(provider.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env[provider.key]}`,
        },
        body: JSON.stringify({
            model: provider.model,
            messages: [
                { role: "system", content: AI_SYSTEM_PROMPT },
                ...messages,
            ],
            max_completion_tokens: 512,
            temperature: 0.7,
        }),
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`${provider.name} ${response.status}: ${data?.error?.message || "provider error"}`);
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) throw new Error(`${provider.name}: empty response`);
    return String(reply);
}

async function requestGeminiProvider(provider, messages) {
    const contents = messages.map(msg => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
    }));

    const response = await fetch(`${provider.url}${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(process.env[provider.key])}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(`${provider.name} ${response.status}: ${data?.error?.message || "provider error"}`);
    }

    const reply = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!reply) throw new Error(`${provider.name}: empty response`);
    return reply;
}

app.get("/api/ai/config", (req, res) => {
    const providers = getConfiguredAIProviders();
    res.json({
        success: true,
        enabled: providers.length > 0,
        name: AI_NAME,
        model: AI_MODEL,
        providers: providers.map(provider => provider.name),
    });
});

app.post("/api/ai/chat", async (req, res) => {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ success: false, error: "messages must be a non-empty array" });
    }

    const providers = getConfiguredAIProviders();
    if (!providers.length) {
        return res.status(503).json({ success: false, error: "AI not configured on the server" });
    }

    const safeMessages = messages
        .filter(msg => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string")
        .slice(-20)
        .map(msg => ({ role: msg.role, content: String(msg.content).slice(0, 4000) }));

    const errors = [];

    for (const provider of providers) {
        try {
            const reply = provider.name === "Gemini"
                ? await requestGeminiProvider(provider, safeMessages)
                : await requestOpenAICompatibleProvider(provider, safeMessages);

            console.log(`[AI] ${provider.name} responded successfully`);
            return res.json({ success: true, name: AI_NAME, reply, provider: provider.name });
        } catch (err) {
            errors.push(`${provider.name}: ${err.message}`);
            console.warn(`[AI] ${provider.name} failed; trying next provider:`, err.message);
        }
    }

    res.status(502).json({
        success: false,
        error: "All configured AI providers failed",
        details: errors,
    });
});

// ─── WEB CHAT ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Yin Global Chat</title>
<style>
  :root {
    --bg: #08080c;
    --panel: rgba(20,20,28,.88);
    --panel-2: rgba(27,27,38,.92);
    --line: rgba(255,255,255,.08);
    --text: #f4f2f7;
    --muted: #94919f;
    --accent: #b66cff;
    --accent-2: #e08cff;
    --mine: #7c4dff;
  }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body {
    margin: 0;
    color: var(--text);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at 15% 15%, rgba(174,83,255,.16), transparent 30%),
      radial-gradient(circle at 85% 85%, rgba(86,71,255,.13), transparent 32%),
      var(--bg);
    display: grid;
    place-items: center;
    padding: 18px;
  }
  button, input { font: inherit; }
  .shell {
    width: min(1120px, 100%);
    height: min(820px, calc(100vh - 36px));
    min-height: 560px;
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 26px;
    background: rgba(12,12,17,.82);
    box-shadow: 0 30px 90px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04);
    backdrop-filter: blur(24px);
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    padding: 22px 16px;
    border-right: 1px solid var(--line);
    background: rgba(10,10,14,.62);
  }
  .brand { display: flex; align-items: center; gap: 11px; padding: 4px 8px 24px; }
  .brand-mark {
    width: 40px; height: 40px; border-radius: 13px; display: grid; place-items: center;
    background: linear-gradient(135deg, #c77dff, #6c63ff); box-shadow: 0 8px 26px rgba(139,92,246,.3); font-size: 21px;
  }
  .brand-title { font-weight: 800; letter-spacing: -.3px; }
  .brand-sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .nav { display: grid; gap: 6px; }
  .nav-item {
    padding: 11px 12px; border-radius: 12px; color: #aaa7b4; font-size: 13px; display: flex; align-items: center; gap: 10px;
  }
  .nav-item.active { color: #fff; background: rgba(182,108,255,.13); border: 1px solid rgba(182,108,255,.16); }
  .status-card { margin-top: auto; padding: 13px; border: 1px solid var(--line); border-radius: 15px; background: rgba(255,255,255,.025); }
  .status-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #35d27d; box-shadow: 0 0 12px #35d27d; }
  .main { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: linear-gradient(180deg, rgba(255,255,255,.018), transparent 35%); }
  .topbar {
    min-height: 74px; padding: 15px 22px; display: flex; align-items: center; justify-content: space-between; gap: 15px;
    border-bottom: 1px solid var(--line); background: rgba(10,10,14,.55); backdrop-filter: blur(16px);
  }
  .room-title { font-size: 16px; font-weight: 800; }
  .room-sub { margin-top: 3px; color: var(--muted); font-size: 11px; }
  .online-pill { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 999px; color: #c7c4cf; font-size: 12px; background: rgba(255,255,255,.025); }
  .messages {
    flex: 1; min-height: 0; overflow-y: auto; padding: 24px 26px; display: flex; flex-direction: column; gap: 17px;
    scrollbar-width: thin; scrollbar-color: #3a3745 transparent;
  }
  .day { text-align: center; color: #6f6c77; font-size: 10px; margin: 2px 0 3px; }
  .message-row { display: flex; gap: 10px; align-items: flex-end; max-width: 86%; }
  .message-row.mine { align-self: flex-end; flex-direction: row-reverse; }
  .avatar { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 11px; display: grid; place-items: center; background: #25232e; color: #c8b7ff; font-weight: 800; font-size: 12px; border: 1px solid var(--line); }
  .bubble-wrap { min-width: 0; }
  .meta { display: flex; align-items: center; gap: 8px; margin: 0 7px 5px; color: #8e8a98; font-size: 10px; }
  .message-row.mine .meta { justify-content: flex-end; }
  .bubble { padding: 10px 13px; border: 1px solid var(--line); border-radius: 16px 16px 16px 5px; background: var(--panel-2); box-shadow: 0 6px 20px rgba(0,0,0,.14); line-height: 1.48; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .message-row.mine .bubble { border-radius: 16px 16px 5px 16px; background: linear-gradient(135deg, #7a4cff, #9d5dff); border-color: rgba(255,255,255,.12); color: #fff; }
  .composer { flex: 0 0 auto; padding: 14px 18px 17px; border-top: 1px solid var(--line); background: rgba(9,9,13,.72); }
  .identity { display: flex; gap: 8px; margin-bottom: 9px; }
  .field, .send-btn { border: 1px solid var(--line); outline: none; color: var(--text); background: rgba(255,255,255,.045); }
  .field { border-radius: 13px; padding: 11px 13px; }
  #name { width: 180px; }
  .send-line { display: flex; gap: 9px; }
  #message { flex: 1; min-width: 0; }
  .send-btn { width: 50px; border-radius: 14px; cursor: pointer; background: linear-gradient(135deg, #9b59ff, #c16bff); border: 0; font-size: 18px; box-shadow: 0 8px 22px rgba(155,89,255,.2); }
  .send-btn:disabled { opacity: .45; cursor: default; }
  .hint { margin: 8px 4px 0; color: #66636f; font-size: 10px; }
  .empty { margin: auto; text-align: center; color: #777480; }
  .empty-icon { width: 52px; height: 52px; display: grid; place-items: center; margin: 0 auto 10px; border-radius: 17px; background: rgba(182,108,255,.1); font-size: 24px; }
  .typing { display: inline-flex; gap: 4px; padding: 10px 13px; border-radius: 15px; background: #20202a; border: 1px solid var(--line); }
  .typing i { width: 5px; height: 5px; border-radius: 50%; background: #aaa5b4; animation: pulse 1s infinite ease-in-out; }
  .typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes pulse { 0%, 60%, 100% { transform: translateY(0); opacity: .45; } 30% { transform: translateY(-3px); opacity: 1; } }
  @media (max-width: 760px) {
    body { padding: 0; }
    .shell { width: 100%; height: 100vh; min-height: 0; border-radius: 0; grid-template-columns: 1fr; }
    .sidebar { display: none; }
    .messages { padding: 18px 14px; }
    .message-row { max-width: 94%; }
    .topbar { padding: 13px 15px; }
    .composer { padding: 11px 11px 14px; }
    #name { width: 135px; }
  }
</style>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">☯</div>
      <div><div class="brand-title">Yin Yang</div><div class="brand-sub">Global community</div></div>
    </div>
    <div class="nav">
      <div class="nav-item active">💬 <span>Global Chat</span></div>
      <div class="nav-item">🤖 <span>Yin AI</span></div>
      <div class="nav-item">🎵 <span>Spotify</span></div>
    </div>
    <div class="status-card">
      <div class="status-row"><span>Servidor</span><span class="dot"></span></div>
      <div style="color:#777480;font-size:10px;margin-top:6px">Render • tiempo real</div>
    </div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div><div class="room-title">Global Chat</div><div class="room-sub">Mensajes compartidos con la librería Yin Yang</div></div>
      <div class="online-pill"><span class="dot"></span><span id="online">0 online</span></div>
    </header>
    <section class="messages" id="messages">
      <div class="empty"><div class="empty-icon">☯</div><div>Conectando al Global Chat...</div></div>
    </section>
    <footer class="composer">
      <div class="identity"><input class="field" id="name" maxlength="32" placeholder="Tu nombre" autocomplete="off"></div>
      <div class="send-line"><input class="field" id="message" maxlength="500" placeholder="Escribe un mensaje..." autocomplete="off"><button class="send-btn" id="send" type="button" aria-label="Enviar">➤</button></div>
      <div class="hint">Tip: en la librería, usa <b>/IA hola</b> para hablar con la IA.</div>
    </footer>
  </main>
</div>
<script>
  const nameInput = document.getElementById('name');
  const messageInput = document.getElementById('message');
  const sendButton = document.getElementById('send');
  const messagesBox = document.getElementById('messages');
  const onlineBox = document.getElementById('online');
  const playerId = 'web-' + Math.random().toString(36).slice(2) + Date.now();
  let lastSignature = '';

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  }
  function initials(name) {
    return String(name || '?').trim().slice(0, 2).toUpperCase();
  }
  function render(data) {
    const list = Array.isArray(data.messages) ? data.messages : [];
    onlineBox.textContent = String(Number(data.onlineCount || 0)) + ' online';
    const signature = JSON.stringify(list.map(m => [m.id, m.playerName, m.message, m.timestamp]));
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (!list.length) {
      messagesBox.innerHTML = '<div class="empty"><div class="empty-icon">☯</div><div>Todavía no hay mensajes.<br>Empieza la conversación.</div></div>';
      return;
    }
    messagesBox.innerHTML = list.map(m => {
      const mine = String(m.playerId) === String(playerId);
      const date = new Date(Number(m.timestamp) * 1000);
      const time = isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return '<div class="message-row ' + (mine ? 'mine' : '') + '">' +
        '<div class="avatar">' + escapeHtml(initials(m.playerName)) + '</div>' +
        '<div class="bubble-wrap"><div class="meta"><b>' + escapeHtml(m.playerName) + '</b><span>' + time + '</span></div>' +
        '<div class="bubble">' + escapeHtml(m.message) + '</div></div></div>';
    }).join('');
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
  async function loadMessages() {
    try {
      const response = await fetch('/api/chat/messages', {cache: 'no-store'});
      if (!response.ok) throw new Error('request failed');
      render(await response.json());
    } catch (error) {
      onlineBox.textContent = 'Sin conexión';
    }
  }
  async function sendMessage() {
    const playerName = nameInput.value.trim();
    const message = messageInput.value.trim();
    if (!playerName || !message || sendButton.disabled) return;
    sendButton.disabled = true;
    try {
      const response = await fetch('/api/chat/send', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({playerName, playerId, message})
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.error || 'send failed');
      messageInput.value = '';
      await loadMessages();
      messageInput.focus();
    } catch (error) {
      alert('No se pudo enviar el mensaje.');
    } finally {
      sendButton.disabled = false;
    }
  }
  sendButton.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', event => { if (event.key === 'Enter') sendMessage(); });
  loadMessages();
  setInterval(loadMessages, 2000);
</script>
</body>
</html>`);
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[ChatGlobal] Backend running on port ${PORT}`);
});
                              

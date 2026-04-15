// Telegram notification service for private messages
// Endpoint: POST /api/notify-private-message

const SUPABASE_CONFIG = {
  url: process.env.SUPABASE_URL || "",
  anonKey: process.env.SUPABASE_ANON_KEY || "",
};

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";

function setCorsHeaders(req, res) {
  const requestOrigin = String((req && req.headers && req.headers.origin) || "");
  const envOrigins = String(process.env.CORS_ALLOW_ORIGIN || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const defaultOrigins = [
    "https://black-russia-simulator.vercel.app",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
  ];

  const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;
  const allowAny = allowedOrigins.includes("*");

  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function parseRequestPayload(req) {
  const body = req && req.body;

  if (body && typeof body === "object") {
    return body;
  }

  if (typeof body === "string") {
    const raw = body.trim();
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch (e) {
      const params = new URLSearchParams(raw);
      return {
        receiver_id: params.get("receiver_id") || "",
        sender_nick: params.get("sender_nick") || "",
        message: params.get("message") || "",
      };
    }
  }

  return {};
}

async function supabaseSelect(table, query) {
  const baseUrl = String(SUPABASE_CONFIG.url || "").replace(/\/+$/, "");
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const url = `${baseUrl}/rest/v1/${table}${qs}`;
  
  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SUPABASE_CONFIG.anonKey,
      Authorization: `Bearer ${SUPABASE_CONFIG.anonKey}`,
      "Content-Type": "application/json",
    },
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${table} failed: ${response.status} :: ${text}`);
  }
  
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

function escapeMarkdownV2(s) {
  if (typeof s !== "string") s = String(s || "");
  return s.replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, "\\$1");
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text, ...extra };
  
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API failed: ${JSON.stringify(data)}`);
  }
  
  return data;
}

async function notifyPlayerAboutPrivateMessage(receiverId, senderNick, messageText) {
  try {
    console.log(`[notify-private-message] Processing: receiver=${receiverId}, sender=${senderNick}`);
    
    // Get receiver player data
    const receivers = await supabaseSelect("players", {
      select: "telegram_id,nick",
      id: `eq.${receiverId}`,
      limit: "1"
    });
    
    if (!receivers || !receivers.length) {
      console.warn(`[notify-private-message] Receiver ${receiverId} not found`);
      return { ok: false, error: "Receiver not found" };
    }
    
    const receiver = receivers[0];
    const telegramId = Number(receiver.telegram_id || 0);
    
    if (!telegramId) {
      console.warn(`[notify-private-message] Receiver ${receiverId} has no telegram_id`);
      return { ok: false, error: "No Telegram ID" };
    }
    
    // Prepare message
    const msgPreview = String(messageText || "").substring(0, 100);
    const displayText = `💬 *Новое личное сообщение в игре!*\n\n` +
      `👤 От: *${escapeMarkdownV2(senderNick)}*\n` +
      `📝 Сообщение: _${escapeMarkdownV2(msgPreview)}${messageText && messageText.length > 100 ? "…" : ""}_\n\n` +
      `🎮 *Перейти в игру и ответить*`;
    
    const keyboard = {
      inline_keyboard: [[
        { text: "📱 Открыть игру", url: "https://black-russia-simulator.vercel.app/" }
      ]]
    };
    
    // Send notification
    await sendTelegramMessage(telegramId, displayText, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard
    });
    
    console.log(`[notify-private-message] Notification sent to ${telegramId} (${receiver.nick})`);
    return { ok: true, sent_to: telegramId };
    
  } catch (err) {
    console.error(`[notify-private-message] Error:`, err.message);
    return { ok: false, error: err.message };
  }
}

export default async function handler(req, res) {
  try {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "notify-private-message ready" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const payload = parseRequestPayload(req);
    const { receiver_id, sender_nick, message } = payload;
    
    if (!receiver_id || !sender_nick || !message) {
      return res.status(400).json({ 
        ok: false, 
        error: "Missing required fields: receiver_id, sender_nick, message" 
      });
    }
    
    if (!TG_BOT_TOKEN || !SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
      return res.status(500).json({ 
        ok: false, 
        error: "Missing environment variables" 
      });
    }
    
    const result = await notifyPlayerAboutPrivateMessage(receiver_id, sender_nick, message);
    
    return res.status(result.ok ? 200 : 400).json(result);
    
  } catch (err) {
    console.error("[notify-private-message] Handler error:", err);
    return res.status(500).json({ 
      ok: false, 
      error: err.message || "Internal server error" 
    });
  }
}

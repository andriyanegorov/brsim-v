// BR Simulator Telegram Bot for Vercel (Node.js)
// Usage: deploy folder with api/bot.js to Vercel. Set env vars in Vercel Project.

const USER_STATE_PREFIX = "state:user:";
const ADMIN_STATE_PREFIX = "state:admin:";
const SUPPORT_THREAD_PREFIX = "support:thread:";
const SUPPORT_PLAYER_PREFIX = "support:player:";
const PAGE_SIZE_INV = 5;

const store = {
  state: new Map(),
  supportThread: new Map(),
  supportPlayer: new Map(),
};

function parseIdList(s) {
  return String(s || "")
    .split(/[\s,;\n]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => !!n);
}

function buildRuntimeConfig() {
  const cfg = {
    botToken: process.env.TG_BOT_TOKEN || "",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    adminChatId: Number(process.env.ADMIN_CHAT_ID || 0),
    adminIds: parseIdList(process.env.ADMIN_IDS || ""),
    topics: {
      actions: Number(process.env.TOPIC_LOG_ACTIONS || 0),
      support: Number(process.env.TOPIC_SUPPORT || 0),
      broadcasts: Number(process.env.TOPIC_BROADCASTS || 0),
      errors: Number(process.env.TOPIC_ERRORS || 0),
      admin: Number(process.env.TOPIC_ADMIN_COMMANDS || 0),
    },
  };
  return cfg;
}

function stateKey(prefix, id) {
  return `${prefix}${id}`;
}

function getState(key) {
  const entry = store.state.get(key);
  if (!entry) return null;
  if (entry.expires && Date.now() > entry.expires) {
    store.state.delete(key);
    return null;
  }
  return entry.value;
}

function setState(key, value, ttlSeconds = 300) {
  store.state.set(key, {
    value,
    expires: Date.now() + ttlSeconds * 1000,
  });
}

function clearState(key) {
  store.state.delete(key);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    const message = `HTTP ${res.status} ${res.statusText} ${url} -> ${text}`;
    throw new Error(message);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}

async function tgApi(method, payload) {
  const cfg = buildRuntimeConfig();
  const url = `https://api.telegram.org/bot${cfg.botToken}/${method}`;
  const res = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(res)}`);
  }
  return res;
}

async function supabaseRequest(method, path, payload) {
  const cfg = buildRuntimeConfig();
  const baseUrl = String(cfg.supabaseUrl || "").replace(/\/+$/, "");
  const url = `${baseUrl}/rest/v1/${path}`;
  const headers = {
    apikey: cfg.supabaseAnonKey,
    Authorization: `Bearer ${cfg.supabaseAnonKey}`,
    "Content-Type": "application/json",
  };
  const response = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body: payload === undefined || payload === null ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${method} ${path} failed: ${response.status} :: ${text}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

async function supabaseSelect(table, query) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  return await supabaseRequest("get", `${table}${qs}`);
}

async function supabaseInsert(table, rows, onConflict) {
  const path = onConflict ? `${table}?on_conflict=${encodeURIComponent(onConflict)}` : table;
  return await supabaseRequest("post", path, rows);
}

async function supabasePatch(table, filters, body) {
  const qs = filters ? `?${new URLSearchParams(filters).toString()}` : "";
  return await supabaseRequest("patch", `${table}${qs}`, body);
}

async function sendMessage(chatId, text, extra = {}) {
  if (extra && extra.parse_mode === "MarkdownV2") {
    text = escapeMarkdownV2(text);
  }
  const payload = { chat_id: chatId, text, ...extra };
  const res = await tgApi("sendMessage", payload);
  return res.ok;
}

async function sendToPlayer(telegramId, text, extra = {}) {
  return await sendMessage(Number(telegramId), text, extra);
}

async function answerCallbackQuery(callbackQueryId, text) {
  await tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
}

async function sendToTopic(topicId, text, runtime, extra = {}) {
  if (!topicId || !runtime || !runtime.adminChatId) return false;
  // Reuse sendMessage to ensure MarkdownV2 escaping logic is applied consistently.
  return await sendMessage(runtime.adminChatId, text, { message_thread_id: topicId, ...extra });
}

function isAdmin(userId, runtime) {
  const uid = Number(userId || 0);
  return runtime.adminIds.indexOf(uid) !== -1;
}

async function ensureLinkedPlayer(tgUser, runtime) {
  const tgId = Number(tgUser.id || 0);
  if (!tgId) return null;

  let rows = await supabaseSelect("players", { select: "*", telegram_id: `eq.${tgId}`, limit: "1" });
  if (rows && rows.length) return rows[0];

  const gameId = `tg_${tgId}`;
  rows = await supabaseSelect("players", { select: "*", id: `eq.${gameId}`, limit: "1" });
  if (rows && rows.length) {
    const p = rows[0];
    await supabasePatch("players", { id: `eq.${p.id}` }, {
      telegram_id: tgId,
      telegram_username: String(tgUser.username || ""),
    });
    p.telegram_id = tgId;
    p.telegram_username = String(tgUser.username || "");
    return p;
  }

  const newPlayer = {
    id: gameId,
    nick: buildNickFromTg(tgUser),
    server: "Сервер",
    balance: 1500,
    inventory: [],
    stats: { opened: 0, itemsSold: 0, valueSold: 0 },
    telegram_id: tgId,
    telegram_username: String(tgUser.username || ""),
    used_promos: [],
  };

  const inserted = await supabaseInsert("players", [newPlayer], "id");
  return inserted && inserted.length ? inserted[0] : newPlayer;
}

async function getPlayerById(playerId) {
  const rows = await supabaseSelect("players", { select: "*", id: `eq.${playerId}`, limit: "1" });
  return rows && rows.length ? rows[0] : null;
}

async function searchPlayerByNick(nickLike) {
  const q = String(nickLike || "").trim();
  if (!q) return null;
  const rows = await supabaseSelect("players", { select: "*", nick: `ilike.*${q.replace(/\*/g, "")}*`, limit: "1" });
  return rows && rows.length ? rows[0] : null;
}

async function updatePlayerFields(playerId, fields) {
  return await supabasePatch("players", { id: `eq.${playerId}` }, fields);
}

async function getPromoByCode(code) {
  const rows = await supabaseSelect("promocodes", { select: "code,reward,is_active", code: `eq.${code}`, limit: "1" });
  return rows && rows.length ? rows[0] : null;
}

async function getActivePromos() {
  try {
    return await supabaseSelect("promocodes", { select: "code,reward,is_active", is_active: "eq.true", order: "code.asc", limit: "200" }) || [];
  } catch (e) {
    const rows = await supabaseSelect("promocodes", { select: "code,reward", order: "code.asc", limit: "200" }) || [];
    return rows.map((r) => ({ ...r, is_active: true }));
  }
}

async function upsertPromo(code, reward) {
  const row = { code: String(code || "").toUpperCase(), reward: Number(reward || 0), is_active: true, updated_at: new Date().toISOString() };
  return await supabaseInsert("promocodes", [row], "code");
}

function buildNickFromTg(tgUser) {
  const fn = String((tgUser && tgUser.first_name) || "").trim();
  const ln = String((tgUser && tgUser.last_name) || "").trim();
  const uname = String((tgUser && tgUser.username) || "").trim();
  const base = (fn + " " + ln).trim();
  if (base) return base;
  if (uname) return uname;
  return "Player_" + Number((tgUser && tgUser.id) || 0);
}

function escapeMd(s) {
  return String(s || "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeMarkdownV2(s) {
  if (typeof s !== "string") s = String(s || "");
  return s.replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, "\\$1");
}

async function createSupportThread(player, runtime) {
  const name = `💬 ТП #${Number(player.telegram_id || 0)} - ${String(player.nick || player.id || "player")}`;
  const r = await tgApi("createForumTopic", { chat_id: runtime.adminChatId, name: name.substring(0, 120) });
  const threadId = (r && r.result && Number(r.result.message_thread_id)) || 0;
  if (!threadId) return 0;

  store.supportThread.set(SUPPORT_THREAD_PREFIX + threadId, Number(player.telegram_id || 0));
  store.supportPlayer.set(SUPPORT_PLAYER_PREFIX + Number(player.telegram_id || 0), threadId);

  await sendToTopic(threadId, "🆕 *Новый тикет*\n👤 Игрок: " + escapeMd(player.nick || player.id) + "\n🆔 Telegram ID: `" + player.telegram_id + "`", runtime, { parse_mode: "MarkdownV2" });
  await sendToTopic(runtime.topics.support, `💬 Создан новый тикет: thread ${threadId} для игрока ${escapeMd(player.nick || player.id)}`, runtime, { parse_mode: "MarkdownV2" });
  return threadId;
}

function getSupportPlayerByThread(threadId) {
  return Number(store.supportThread.get(SUPPORT_THREAD_PREFIX + threadId) || 0);
}

function getSupportThreadByPlayer(tgId) {
  return Number(store.supportPlayer.get(SUPPORT_PLAYER_PREFIX + tgId) || 0);
}

async function safeLogError(err, where) {
  try {
    const runtime = buildRuntimeConfig();
    const msg = `⚠️ *ОШИБКА*\n📍 Где: ${escapeMd(where || "unknown")}\n🧾 Текст: ${escapeMd(String(err && err.message ? err.message : err))}\n🕒 ${escapeMd(new Date().toISOString())}`;
    if (runtime.topics && runtime.topics.errors) {
      await sendToTopic(runtime.topics.errors, msg, runtime, { parse_mode: "MarkdownV2" });
    }
    console.error(where || "error", err);
  } catch (inner) {
    console.error("safeLogError_ failed", inner);
  }
}

async function sendPlayerMainMenu(chatId, player) {
  await sendMessage(chatId,
    `👋 *BR Simulator*\nВаш профиль привязан: *${escapeMd(player.nick || player.id)}*\n\nВыберите действие:`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟦 💰 Баланс", callback_data: "pl:balance" }, { text: "🟪 📦 Инвентарь", callback_data: "pl:inventory:0" }],
          [{ text: "🟨 🎁 Промокод", callback_data: "pl:promo" }, { text: "🟥 📞 Техподдержка", callback_data: "pl:support" }],
          [{ text: "⬜ 📊 Статистика", callback_data: "pl:stats" }],
        ],
      },
    }
  );
}

async function sendInventoryPage(chatId, player, page) {
  const inv = Array.isArray(player.inventory) ? player.inventory : [];
  const totalPages = Math.max(1, Math.ceil(inv.length / PAGE_SIZE_INV));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * PAGE_SIZE_INV;
  const part = inv.slice(start, start + PAGE_SIZE_INV);

  let txt = `📦 *Инвентарь*\nСтраница ${safePage + 1} / ${totalPages}\n`;
  if (!part.length) {
    txt += "\nПусто";
  } else {
    for (let i = 0; i < part.length; i++) {
      const it = part[i] || {};
      txt += `\n${start + i + 1}. ${escapeMd(it.name || "Unknown")}\n   Редкость: ${escapeMd(String(it.rarity || "-"))} | Цена: ${Number(it.value || 0)} BC\n`;
    }
  }

  const navRow = [];
  if (safePage > 0) navRow.push({ text: "⬅️", callback_data: `pl:inventory:${safePage - 1}` });
  navRow.push({ text: "◀️ Меню", callback_data: "pl:menu" });
  if (safePage < totalPages - 1) navRow.push({ text: "➡️", callback_data: `pl:inventory:${safePage + 1}` });

  await sendMessage(chatId, txt, { parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: [navRow] } });
}

async function activatePromoForPlayer(player, inputCode, runtime, chatId) {
  const code = String(inputCode || "").trim().toUpperCase();
  if (!code) {
    await sendMessage(chatId, "⚠️ Пустой промокод.");
    return;
  }

  const used = Array.isArray(player.used_promos) ? [...player.used_promos] : [];
  if (used.includes(code)) {
    await sendMessage(chatId, "⚠️ Вы уже активировали этот промокод.");
    return;
  }

  const promo = await getPromoByCode(code);
  if (!promo || !promo.is_active) {
    await sendMessage(chatId, "❌ Промокод не найден или неактивен.");
    return;
  }

  const reward = Number(promo.reward || 0);
  if (reward <= 0) {
    await sendMessage(chatId, "❌ У промокода некорректная награда.");
    return;
  }

  used.push(code);
  const nextBalance = Number(player.balance || 0) + reward;
  await updatePlayerFields(player.id, { balance: nextBalance, used_promos: used, telegram_id: Number(player.telegram_id || 0), telegram_username: String(player.telegram_username || "") });

  await sendMessage(chatId, `🎉 Промокод активирован\n💰 Начислено: *${reward} BC*`, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [[{ text: "🔵 Показать баланс", callback_data: "pl:show_balance" }]] },
  });

  await sendToTopic(runtime.topics.actions, "🎁 *Активация промокода*\n👤 Игрок: " + escapeMd(player.nick || player.id) + "\n🏷️ Код: `" + escapeMd(code) + "`\n💰 Награда: " + reward + " BC", runtime, { parse_mode: "MarkdownV2" });
}

async function processSupportMessage(player, text, runtime, from) {
  if (!text) {
    await sendMessage(Number(player.telegram_id), "⚠️ Сообщение пустое.");
    return;
  }

  const tgId = Number(player.telegram_id);
  let threadId = getSupportThreadByPlayer(tgId);

  if (!threadId) {
    threadId = await createSupportThread(player, runtime);
    if (!threadId) {
      await sendMessage(tgId, "⚠️ Не удалось создать тикет. Попробуйте позже.");
      return;
    }
  }

  const username = from && from.username ? `@${from.username}` : `id:${tgId}`;
  const topicText = `💬 *Новое сообщение от игрока*\n👤 ${escapeMd(player.nick || player.id)} (${escapeMd(username)})\n\n${escapeMd(text)}`;
  await sendToTopic(threadId, topicText, runtime, { parse_mode: "MarkdownV2" });
}

async function adminOpenPlayerCard(query, chatId, threadId, runtime) {
  let player = await getPlayerById(query);
  if (!player) player = await searchPlayerByNick(query);

  if (!player) {
    await sendMessage(chatId, "❌ Игрок не найден.", { message_thread_id: threadId });
    return;
  }
  await sendAdminPlayerCard(chatId, threadId, player, runtime);
}

async function sendAdminPlayerCard(chatId, threadId, player, runtime) {
  const inv = Array.isArray(player.inventory) ? player.inventory : [];
  await sendMessage(chatId,
    "👤 *Карточка игрока*\nID: `" + escapeMd(player.id || "") + "`\nНик: *" + escapeMd(player.nick || "-") + "*\nСервер: *" + escapeMd(player.server || "-") + "*\nБаланс: *" + Number(player.balance || 0).toLocaleString("ru-RU") + " BC*\nИнвентарь: *" + inv.length + "*",
    {
      parse_mode: "MarkdownV2",
      message_thread_id: threadId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟩 ➕ BC +500", callback_data: `ad:bc:${player.id}:500` }, { text: "🟥 ➖ BC -500", callback_data: `ad:bc:${player.id}:-500` }],
          [{ text: "✏️ Сменить ник", callback_data: `ad:setnick:${player.id}` }, { text: "🌍 Сменить сервер", callback_data: `ad:setserver:${player.id}` }],
          [{ text: "📦 Инвентарь", callback_data: `ad:inv:${player.id}` }, { text: "📊 Статистика", callback_data: `ad:stats:${player.id}` }],
        ],
      },
    }
  );
}

async function applyPlayerNickChange(playerId, newNick, adminUser, runtime) {
  const p = await getPlayerById(playerId);
  if (!p) return;
  await updatePlayerFields(playerId, { nick: String(newNick).trim() });
  await sendToTopic(runtime.topics.admin, `🛠️ *Изменение профиля*\n👨‍💼 Админ: ${adminTag(adminUser)}\n👤 Игрок: ${escapeMd(p.nick || p.id)}\n✏️ Новый ник: ${escapeMd(newNick)}`, runtime, { parse_mode: "MarkdownV2" });
}

async function applyPlayerServerChange(playerId, newServer, adminUser, runtime) {
  const p = await getPlayerById(playerId);
  if (!p) return;
  await updatePlayerFields(playerId, { server: String(newServer).trim() });
  await sendToTopic(runtime.topics.admin, `🛠️ *Изменение профиля*\n👨‍💼 Админ: ${adminTag(adminUser)}\n👤 Игрок: ${escapeMd(p.nick || p.id)}\n🌍 Новый сервер: ${escapeMd(newServer)}`, runtime, { parse_mode: "MarkdownV2" });
}

async function adminSendTop(chatId, threadId, runtime) {
  const rows = await supabaseSelect("players", { select: "id,nick,balance,inventory", order: "balance.desc", limit: "500" });
  const scored = (rows || []).map((p) => {
    const inv = Array.isArray(p.inventory) ? p.inventory : [];
    let invValue = 0;
    for (let i = 0; i < inv.length; i++) invValue += Number((inv[i] || {}).value || 0);
    return { id: p.id, nick: p.nick, balance: Number(p.balance || 0), invValue, score: Number(p.balance || 0) + invValue };
  }).sort((a, b) => b.score - a.score).slice(0, 25);

  let text = "🏆 *Топ-25 игроков*\n\n";
  for (let j = 0; j < scored.length; j++) {
    const s = scored[j];
    text += `${j+1}. ${escapeMd(s.nick || s.id)} — *${s.score.toLocaleString("ru-RU")}*\n`;
  }
  await sendMessage(chatId, text, { parse_mode: "MarkdownV2", message_thread_id: threadId });
}

async function adminSendPromos(chatId, threadId, runtime) {
  const promos = await getActivePromos();
  let txt = "🎁 *Активные промокоды*\n\n";
  if (!promos.length) txt += "Пусто";
  else for (let i = 0; i < promos.length; i++) txt += "• `" + escapeMd(promos[i].code) + "` — *" + Number(promos[i].reward || 0) + " BC*\n";

  await sendMessage(chatId, txt, { parse_mode: "MarkdownV2", message_thread_id: threadId, reply_markup: { inline_keyboard: [[{ text: "🟩 ➕ Создать", callback_data: "ad:promos:create" }]] } });
}

async function broadcastToAllPlayers(text, runtime) {
  const rows = await supabaseSelect("players", { select: "telegram_id", telegram_id: "not.is.null", limit: "5000" }) || [];
  let sent = 0;
  for (let i = 0; i < rows.length; i++) {
    const tgId = Number(rows[i].telegram_id || 0);
    if (!tgId) continue;
    const ok = await sendMessage(tgId, `📢 *Сообщение от администрации*\n\n${escapeMd(text)}`, { parse_mode: "MarkdownV2" });
    if (ok) sent++;
  }
  return sent;
}

async function broadcastToIds(ids, text, runtime) {
  const sent = [];
  for (const id of ids) {
    const ok = await sendMessage(id, `📢 *Сообщение от администрации*\n\n${escapeMd(text)}`, { parse_mode: "MarkdownV2" });
    if (ok) sent.push(id);
  }
  return sent;
}

async function handlePlayerCallback(cq, player, runtime) {
  const data = String(cq.data || "");
  const chatId = cq.message.chat.id;

  if (data === "pl:balance" || data === "pl:show_balance") {
    const balanceText = "💰 *Ваш баланс:* `" + Number(player.balance || 0).toLocaleString("ru-RU") + " BC`";
    await sendMessage(chatId, balanceText, {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "🔵 Обновить", callback_data: "pl:balance" }], [{ text: "◀️ Меню", callback_data: "pl:menu" }]] }
    });
    return;
  }

  if (data === "pl:menu") { await sendPlayerMainMenu(chatId, player); return; }
  if (data.startsWith("pl:inventory:")) {
    const page = Number(data.split(":")[2] || 0);
    await sendInventoryPage(chatId, player, page); return;
  }
  if (data === "pl:promo") { setState(stateKey(USER_STATE_PREFIX, Number(cq.from.id)), { mode: "await_promo_code" }, 600); await sendMessage(chatId, "🎁 Введите промокод одним сообщением."); return; }
  if (data === "pl:support") { setState(stateKey(USER_STATE_PREFIX, Number(cq.from.id)), { mode: "await_support_text" }, 1800); await sendMessage(chatId, "📞 Напишите сообщение для техподдержки.\n\nОпишите проблему как можно подробнее."); return; }
  if (data === "pl:stats") {
    const stats = player.stats || {};
    const opened = Number(stats.opened || 0);
    const soldItems = Number(stats.itemsSold || 0);
    const soldValue = Number(stats.valueSold || 0);
    const fav = detectFavoriteCase(stats);
    await sendMessage(chatId, `📊 *Статистика*\n📦 Открыто кейсов: *${opened}*\n🧾 Продано предметов: *${soldItems}*\n💸 На сумму: *${soldValue.toLocaleString("ru-RU")}*\n❤️ Любимый кейс: *${escapeMd(fav)}*`, { parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: [[{ text: "◀️ Меню", callback_data: "pl:menu" }]] } });
    return;
  }
}

async function handleAdminCallback(cq, runtime) {
  const data = String(cq.data || "");
  const from = cq.from || {};
  const adminId = Number(from.id);
  const chatId = cq.message.chat.id;
  const threadId = cq.message.message_thread_id;

  if (data.startsWith("ad:bcst:")) {
    const mode = data.split(":")[2] || "";
    if (mode === "all") { setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_broadcast_text_all" }, 1800); await sendMessage(chatId, "✍️ Введите текст рассылки для всех игроков.", { message_thread_id: threadId }); return; }
    if (mode === "list") { setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_broadcast_ids" }, 1800); await sendMessage(chatId, "👥 Введите Telegram ID через запятую: `12345,67890`", { message_thread_id: threadId, parse_mode: "MarkdownV2" }); return; }
  }

  if (data.startsWith("ad:edit:")) {
    const playerId = data.substring("ad:edit:".length);
    const p = await getPlayerById(playerId);
    if (!p) { await sendMessage(chatId, "Игрок не найден", { message_thread_id: threadId }); return; }
    await sendAdminPlayerCard(chatId, threadId, p, runtime); return;
  }

  if (data.startsWith("ad:bc:")) {
    const parts = data.split(":");
    const playerId = parts[2] || "";
    const delta = Number(parts[3] || 0);
    const p = await getPlayerById(playerId);
    if (!p) { await sendMessage(chatId, "Игрок не найден", { message_thread_id: threadId }); return; }
    const nextBalance = Math.max(0, Number(p.balance || 0) + delta);
    await updatePlayerFields(playerId, { balance: nextBalance });
    await sendMessage(chatId, `🛠️ *Админ:* ${adminTag(from)}\n👤 *Игрок:* ${escapeMd(p.nick || p.id)} (ID: ${escapeMd(p.id)})\n💰 *Изменение:* ${delta >= 0 ? "+" : ""}${delta} BC\n📌 *Новый баланс:* ${nextBalance} BC`, { parse_mode: "MarkdownV2", message_thread_id: threadId });
    await sendToTopic(runtime.topics.admin, `🛠️ *Админ-команда*\n👨‍💼 ${adminTag(from)}\n👤 Игрок: ${escapeMd(p.nick || p.id)}\n💰 Δ: ${delta >= 0 ? "+" : ""}${delta} BC\n📌 Баланс: ${nextBalance} BC`, runtime, { parse_mode: "MarkdownV2" });
    return;
  }

  if (data.startsWith("ad:setnick:")) { setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_edit_nick", playerId: data.substring("ad:setnick:".length) }, 900); await sendMessage(chatId, "✏️ Введите новый ник одним сообщением.", { message_thread_id: threadId }); return; }
  if (data.startsWith("ad:setserver:")) { setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_edit_server", playerId: data.substring("ad:setserver:".length) }, 900); await sendMessage(chatId, "🌍 Введите новый сервер одним сообщением.", { message_thread_id: threadId }); return; }

  if (data.startsWith("ad:inv:")) {
    const playerId = data.substring("ad:inv:".length);
    const p = await getPlayerById(playerId);
    if (!p) { await sendMessage(chatId, "Игрок не найден", { message_thread_id: threadId }); return; }
    const inv = Array.isArray(p.inventory) ? p.inventory : [];
    let txt = `📦 *Инвентарь игрока* ${escapeMd(p.nick || p.id)}\n`;
    if (!inv.length) txt += "\nПусто";
    for (let i = 0; i < Math.min(inv.length, 30); i++) {
      const it = inv[i] || {};
      txt += `\n${i + 1}. ${escapeMd(it.name || "Unknown")} — ${Number(it.value || 0)} BC`;
    }
    await sendMessage(chatId, txt, { parse_mode: "MarkdownV2", message_thread_id: threadId });
    return;
  }

  if (data.startsWith("ad:stats:")) {
    const playerId = data.substring("ad:stats:".length);
    const p = await getPlayerById(playerId);
    if (!p) { await sendMessage(chatId, "Игрок не найден", { message_thread_id: threadId }); return; }
    const s = p.stats || {};
    await sendMessage(chatId, `📊 *Статистика игрока* ${escapeMd(p.nick || p.id)}\n🎰 Открыто: ${Number(s.opened || 0)}\n💸 Продано предметов: ${Number(s.itemsSold || 0)}\n💰 На сумму: ${Number(s.valueSold || 0)} BC`, { parse_mode: "MarkdownV2", message_thread_id: threadId });
    return;
  }

  if (data === "ad:promos:create") { setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_create_promo" }, 900); await sendMessage(chatId, "➕ Введите `CODE 1000` для создания/обновления промокода.", { message_thread_id: threadId, parse_mode: "MarkdownV2" }); return; }
}

function adminTag(adminUser) {
  if (adminUser && adminUser.username) return "@" + escapeMd(adminUser.username);
  return "`" + Number((adminUser && adminUser.id) || 0) + "`";
}

function detectFavoriteCase(stats) {
  if (!stats || !stats.casesOpenedCount) return "Нет данных";
  const map = stats.casesOpenedCount;
  let best = "Нет данных";
  let bestCount = -1;
  for (const k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
    const n = Number(map[k] || 0);
    if (n > bestCount) { bestCount = n; best = k; }
  }
  return best;
}

async function handleMessage(msg, runtime) {
  const chat = msg.chat || {};
  const from = msg.from || {};
  const text = String(msg.text || "").trim();

  if (chat.type === "private") {
    return await handlePrivateMessage(msg, runtime);
  }

  if (Number(chat.id) === Number(runtime.adminChatId)) {
    return await handleAdminChatMessage(msg, runtime);
  }

  if (text === "/start") {
    await sendMessage(chat.id, "Бот работает в ЛС и в админ-чате.");
  }
}

async function handlePrivateMessage(msg, runtime) {
  const from = msg.from || {};
  const text = String(msg.text || "").trim();
  const userId = Number(from.id);

  const player = await ensureLinkedPlayer(from, runtime);
  if (!player) { await sendMessage(msg.chat.id, "Не удалось привязать аккаунт. Попробуйте позже."); return; }

  if (text === "/start") { await sendPlayerMainMenu(msg.chat.id, player); return; }

  const state = getState(stateKey(USER_STATE_PREFIX, userId));
  if (state && state.mode === "await_promo_code") {
    await activatePromoForPlayer(player, text, runtime, msg.chat.id);
    clearState(stateKey(USER_STATE_PREFIX, userId));
    return;
  }

  if (state && state.mode === "await_support_text") {
    await processSupportMessage(player, text, runtime, from);
    clearState(stateKey(USER_STATE_PREFIX, userId));
    await sendMessage(msg.chat.id, "✅ Обращение отправлено в поддержку. Мы ответим здесь в этом чате.");
    return;
  }

  await sendPlayerMainMenu(msg.chat.id, player);
}

async function handleAdminChatMessage(msg, runtime) {
  const from = msg.from || {};
  const text = String(msg.text || "").trim();
  const adminId = Number(from.id);

  if (!isAdmin(adminId, runtime)) return;

  if (msg.message_thread_id && text && text[0] !== "/") {
    const mappedPlayerTgId = getSupportPlayerByThread(msg.message_thread_id);
    if (mappedPlayerTgId) {
      await sendToPlayer(mappedPlayerTgId, `💬 *Ответ от поддержки*\n\n${escapeMd(text)}`, { parse_mode: "MarkdownV2" });
      const claimKey = `support:claimed:${msg.message_thread_id}`;
      if (!store.state.has(claimKey)) {
        store.state.set(claimKey, { value: String(adminId), expires: Date.now() + 6 * 3600 * 1000 });
        await sendToTopic(runtime.topics.support, `👨‍💻 Обращение взял в работу: ${adminTag(from)}`, runtime);
      }
      return;
    }
  }

  const state = getState(stateKey(ADMIN_STATE_PREFIX, adminId));
  if (state && text && text[0] !== "/") {
    if (state.mode === "await_edit_nick") { await applyPlayerNickChange(state.playerId, text, from, runtime); clearState(stateKey(ADMIN_STATE_PREFIX, adminId)); return; }
    if (state.mode === "await_edit_server") { await applyPlayerServerChange(state.playerId, text, from, runtime); clearState(stateKey(ADMIN_STATE_PREFIX, adminId)); return; }
    if (state.mode === "await_broadcast_text_all") { const sent = await broadcastToAllPlayers(text, runtime); await sendMessage(msg.chat.id, `✅ Рассылка завершена. Отправлено: ${sent}`); await sendToTopic(runtime.topics.broadcasts, `📢 *Рассылка всем*\n👨‍💼 Админ: ${adminTag(from)}\n📨 Отправлено: ${sent}`, runtime, { parse_mode: "MarkdownV2" }); clearState(stateKey(ADMIN_STATE_PREFIX, adminId)); return; }
    if (state.mode === "await_broadcast_ids") {
      const ids = parseIdList(text);
      if (!ids.length) { await sendMessage(msg.chat.id, "⚠️ Не удалось распознать ID. Пример: 12345, 67890"); return; }
      setState(stateKey(ADMIN_STATE_PREFIX, adminId), { mode: "await_broadcast_text_ids", ids }, 1800);
      await sendMessage(msg.chat.id, "✍️ Введите текст рассылки для выбранных ID.");
      return;
    }
    if (state.mode === "await_broadcast_text_ids") {
      const sentIds = await broadcastToIds(state.ids || [], text, runtime);
      await sendMessage(msg.chat.id, `✅ Рассылка по списку завершена. Отправлено: ${sentIds.length}`);
      await sendToTopic(runtime.topics.broadcasts, `📢 *Рассылка по списку*\n👨‍💼 Админ: ${adminTag(from)}\n👥 ID: ${escapeMd(sentIds.join(", "))}`, runtime, { parse_mode: "MarkdownV2" });
      clearState(stateKey(ADMIN_STATE_PREFIX, adminId));
      return;
    }
    if (state.mode === "await_create_promo") {
      const parts = text.split(/\s+/);
      if (parts.length < 2) { await sendMessage(msg.chat.id, "⚠️ Формат: CODE 1000"); return; }
      const code = String(parts[0] || "").toUpperCase();
      const reward = Number(parts[1] || 0);
      if (!code || reward <= 0) { await sendMessage(msg.chat.id, "⚠️ Неверный код или награда."); return; }
      await upsertPromo(code, reward, runtime);
      clearState(stateKey(ADMIN_STATE_PREFIX, adminId));
      await sendMessage(msg.chat.id, `✅ Промокод сохранен: ${code} -> ${reward} BC`);
      await sendToTopic(runtime.topics.admin, "🛠️ *Создан/обновлен промокод*\n👨‍💼 Админ: " + adminTag(from) + "\n🎁 Код: `" + escapeMd(code) + "`\n💰 Награда: " + reward + " BC", runtime, { parse_mode: "MarkdownV2" });
      return;
    }
  }

  if (text.startsWith("/edit_player")) {
    const query = text.replace("/edit_player", "").trim();
    if (!query) { await sendMessage(msg.chat.id, "⚠️ Использование: /edit_player [id или ник]", { message_thread_id: msg.message_thread_id }); return; }
    await adminOpenPlayerCard(query, msg.chat.id, msg.message_thread_id, runtime);
    return;
  }

  if (text === "/broadcast") {
    await sendMessage(msg.chat.id, "📢 Выберите тип рассылки:", { message_thread_id: msg.message_thread_id,
      reply_markup: { inline_keyboard: [[{ text: "🟨 📢 Всем игрокам", callback_data: "ad:bcst:all" }, { text: "🟦 👥 По списку ID", callback_data: "ad:bcst:list" }]] }
    });
    return;
  }

  if (text === "/top") { await adminSendTop(msg.chat.id, msg.message_thread_id, runtime); return; }
  if (text === "/promos") { await adminSendPromos(msg.chat.id, msg.message_thread_id, runtime); return; }
}

async function handleCallbackQuery(cq, runtime) {
  const data = String(cq.data || "");
  const userId = Number((cq.from || {}).id);
  try {
    if (data.startsWith("pl:")) {
      const player = await ensureLinkedPlayer(cq.from, runtime);
      if (!player) { await answerCallbackQuery(cq.id, "Аккаунт не найден"); return; }
      await handlePlayerCallback(cq, player, runtime);
      await answerCallbackQuery(cq.id, "OK");
      return;
    }
    if (data.startsWith("ad:")) {
      if (!isAdmin(userId, runtime)) { await answerCallbackQuery(cq.id, "Нет доступа"); return; }
      await handleAdminCallback(cq, runtime);
      await answerCallbackQuery(cq.id, "OK");
      return;
    }
    await answerCallbackQuery(cq.id, "Неизвестное действие");
  } catch (err) {
    await safeLogError(err, "handleCallbackQuery");
    await answerCallbackQuery(cq.id, "Ошибка");
    if (cq.message && cq.message.chat && cq.message.chat.id) {
      await sendMessage(cq.message.chat.id, "⚠️ Произошла ошибка при обработке кнопки.", { message_thread_id: cq.message.message_thread_id });
    }
  }
}

export default async function handler(req, res) {
  try {
    const runtime = buildRuntimeConfig();
    console.log("[handler] method", req.method);
    console.log("[handler] runtime", {
      botTokenSet: !!runtime.botToken,
      supabaseUrlSet: !!runtime.supabaseUrl,
      supabaseAnonKeySet: !!runtime.supabaseAnonKey,
      adminChatId: runtime.adminChatId,
      adminIds: runtime.adminIds,
      topics: runtime.topics
    });

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, message: "BR Simulator Bot is running", runtime });
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    if (!runtime.botToken || !runtime.supabaseUrl || !runtime.supabaseAnonKey) {
      const errMsg = "Missing required script properties: TG_BOT_TOKEN / SUPABASE_URL / SUPABASE_ANON_KEY";
      console.error("[handler] ", errMsg);
      return res.status(500).json({ ok: false, error: errMsg });
    }

    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    console.log("[handler] update", JSON.stringify(update).slice(0, 1000));

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, runtime);
    } else if (update.message) {
      await handleMessage(update.message, runtime);
    } else {
      console.log("[handler] no message/callback_query in update");
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    await safeLogError(err, "doPost");
    console.error("[handler] error", err);
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

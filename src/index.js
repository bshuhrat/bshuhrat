// Точка входа Cloudflare Worker: вебхук Telegram, настройка и планировщик.
import { handleAdminCallback, handlePrivateMessage } from "./admin.js";
import { Database } from "./db.js";
import { handleGroupCallback, handleGroupMessage } from "./group.js";
import { runScheduled } from "./scheduler.js";
import { Telegram } from "./telegram.js";

let botUsername = null;

function loadConfig(env) {
  if (!env.BOT_TOKEN) throw new Error("Не задан секрет BOT_TOKEN");
  const adminIds = new Set(
    String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  );
  const [hh = "20", mm = "00"] = String(env.DAILY_REPORT_TIME || "20:00").split(":");
  return {
    adminIds,
    groupId: env.GROUP_ID ? Number(env.GROUP_ID) : null,
    timezone: env.TIMEZONE || "Europe/Moscow",
    dailyReportTime: `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`,
    remindBeforeHours: Number(env.REMIND_BEFORE_HOURS || 24),
    photoFixTimeoutMin: Number(env.PHOTO_FIX_TIMEOUT_MIN || 60),
    botUsername,
  };
}

async function makeContext(env) {
  const db = new Database(env.DB);
  await db.init();
  if (!botUsername) botUsername = await db.getSetting("bot_username");
  return { db, tg: new Telegram(env.BOT_TOKEN), cfg: loadConfig(env) };
}

// Секрет вебхука выводится из токена — отдельная настройка не нужна
async function webhookSecret(token) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("webhook:" + token));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function handleUpdate(ctx, update) {
  if (update.message) {
    const msg = update.message;
    if (msg.chat.type === "private") await handlePrivateMessage(ctx, msg);
    else if (["group", "supergroup"].includes(msg.chat.type)) await handleGroupMessage(ctx, msg);
  } else if (update.callback_query) {
    const call = update.callback_query;
    const kind = (call.data || "").split(":")[0];
    if (["rv", "cm", "ans"].includes(kind)) await handleAdminCallback(ctx, call);
    else if (call.message && ctx.cfg.groupId && call.message.chat.id !== ctx.cfg.groupId) return;
    else await handleGroupCallback(ctx, call);
  }
}

const GROUP_COMMANDS = [
  ["tasks", "Открытые задания темы"], ["info", "Описание темы"], ["faq", "Частые вопросы"],
  ["ask", "Вопрос администратору"], ["my", "Моя статистика"], ["help", "Помощь"],
];
const PRIVATE_COMMANDS = [
  ["stats", "Общая статистика"], ["pending", "Работы на проверке"], ["requests", "Вопросы участников"],
  ["export", "Выгрузка в CSV"], ["help", "Помощь"],
];
const toCommands = (list) => list.map(([command, description]) => ({ command, description }));

async function setup(env, url) {
  const ctx = await makeContext(env);
  const me = await ctx.tg.call("getMe");
  botUsername = me.username;
  await ctx.db.setSetting("bot_username", me.username);
  await ctx.tg.call("setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: await webhookSecret(env.BOT_TOKEN),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await ctx.tg.call("setMyCommands", {
    commands: toCommands(GROUP_COMMANDS), scope: { type: "all_group_chats" },
  });
  await ctx.tg.call("setMyCommands", {
    commands: toCommands(PRIVATE_COMMANDS), scope: { type: "all_private_chats" },
  });
  const admins = [...ctx.cfg.adminIds].join(", ") ||
    "не указаны — напишите боту /start, он пришлёт ваш ID, и впишите его в ADMIN_IDS";
  return `✅ Бот @${me.username} подключён.\nАдминистраторы: ${admins}\n` +
    `Часовой пояс: ${ctx.cfg.timezone}\nТеперь напишите боту /start в Telegram.`;
}

const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== (await webhookSecret(env.BOT_TOKEN))) return text("forbidden", 403);
      try {
        await handleUpdate(await makeContext(env), await request.json());
      } catch (e) {
        // Отвечаем 200, иначе Telegram будет бесконечно повторять это обновление
        console.error("Ошибка обработки обновления:", e);
      }
      return text("ok");
    }

    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return text("Сначала добавьте секрет BOT_TOKEN в настройках Worker.", 500);
      if (url.searchParams.get("token") !== env.BOT_TOKEN) {
        return text("Откройте адрес вида /setup?token=ВАШ_ТОКЕН_БОТА", 403);
      }
      try {
        return text(await setup(env, url));
      } catch (e) {
        return text(`❌ Ошибка: ${e.message}`, 500);
      }
    }

    return text("🤖 Бот работает. Для подключения откройте /setup?token=ВАШ_ТОКЕН_БОТА");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(makeContext(env).then(runScheduled));
  },
};

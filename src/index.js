// Точка входа Cloudflare Worker: вебхук Telegram, настройка и планировщик.
import { handleAdminCallback, handlePrivateMessage } from "./admin.js";
import { Database } from "./db.js";
import { handleGroupCallback, handleGroupMessage } from "./group.js";
import { DEFAULT_AI_MODEL } from "./reports.js";
import { runScheduled } from "./scheduler.js";
import { Telegram } from "./telegram.js";
import { parseTopicLink } from "./utils.js";

let botUsername = null;

// Токен без случайных пробелов и переносов строки при вставке
const tokenOf = (env) => String(env.BOT_TOKEN || "").trim();

// "9:00" -> "09:00"
function hhmm(value) {
  const [hh = "0", mm = "0"] = String(value).trim().split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

function loadConfig(env) {
  if (!tokenOf(env)) throw new Error("Не задан секрет BOT_TOKEN");
  const adminIds = new Set(
    String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
  );

  return {
    adminIds,
    groupId: env.GROUP_ID ? Number(env.GROUP_ID) : null,
    timezone: env.TIMEZONE || "Europe/Moscow",
    dailyReportTime: hhmm(env.DAILY_REPORT_TIME || "20:00"),
    remindBeforeHours: Number(env.REMIND_BEFORE_HOURS || 24),
    photoFixTimeoutMin: Number(env.PHOTO_FIX_TIMEOUT_MIN || 60),
    photoTopic: parseTopicLink(env.PHOTO_TOPIC),
    reportTopic: parseTopicLink(env.REPORT_TOPIC),
    aiModel: String(env.AI_MODEL || DEFAULT_AI_MODEL).trim(),
    repairTopic: parseTopicLink(env.REPAIR_TOPIC),
    repairSystemUrl: String(env.REPAIR_SYSTEM_URL || "").trim(),
    // Через сколько часов каждое следующее напоминание; последнее значение повторяется
    repairScheduleHours: String(env.REPAIR_SCHEDULE_HOURS || "4,24,72,168")
      .split(",").map(Number).filter((h) => h > 0),
    photoRemindHours: Number(env.PHOTO_REMIND_HOURS || 7),
    photoRemindFrom: hhmm(env.PHOTO_REMIND_FROM || "09:00"),
    photoRemindTo: hhmm(env.PHOTO_REMIND_TO || "23:59"),
    botUsername,
  };
}

async function makeContext(env) {
  const db = new Database(env.DB);
  await db.init();
  if (!botUsername) botUsername = await db.getSetting("bot_username");
  return { db, tg: new Telegram(tokenOf(env)), cfg: loadConfig(env), images: env.IMAGES, ai: env.AI };
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

async function setup(env, origin) {
  const ctx = await makeContext(env);
  const me = await ctx.tg.call("getMe");
  botUsername = me.username;
  await ctx.db.setSetting("bot_username", me.username);
  await ctx.tg.call("setWebhook", {
    url: `${origin}/webhook`,
    secret_token: await webhookSecret(tokenOf(env)),
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

// Автоподключение без браузера: если задана переменная WORKER_URL, планировщик
// сам регистрирует вебхук (полезно, когда workers.dev не открывается у провайдера).
// Итог сохраняется в setup_status — бот показывает его в ответ на /start.
async function autoSetup(env) {
  const db = new Database(env.DB);
  await db.init();
  const raw = String(env.WORKER_URL || "").trim();
  if (!raw) {
    await db.setSetting("setup_status", "не задана переменная WORKER_URL");
    return;
  }
  let origin;
  try {
    origin = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    await db.setSetting("setup_status", `неверный адрес в WORKER_URL: «${raw}»`);
    return;
  }
  const marker = await webhookSecret(tokenOf(env) + "|" + origin);
  if ((await db.getSetting("auto_setup")) === marker) return;
  try {
    console.log(await setup(env, origin));
    await db.setSetting("auto_setup", marker);
    await db.setSetting("setup_status", "ok");
  } catch (e) {
    await db.setSetting("setup_status", `Telegram не принял адрес ${origin}: ${e.message}`);
  }
}

// Резервный режим: пока вебхук не подключён, забираем сообщения сами (задержка до минуты)
async function pollUpdates(env) {
  const ctx = await makeContext(env);
  const info = await ctx.tg.call("getWebhookInfo");
  if (info.url) return;
  if (!botUsername) {
    botUsername = (await ctx.tg.call("getMe")).username;
    ctx.cfg.botUsername = botUsername;
    await ctx.db.setSetting("bot_username", botUsername);
  }
  ctx.polling = true;
  const offset = Number((await ctx.db.getSetting("poll_offset")) || 0);
  const updates = await ctx.tg.call("getUpdates", {
    offset, timeout: 30, limit: 10, allowed_updates: ["message", "callback_query"],
  });
  for (const update of updates) {
    await ctx.db.setSetting("poll_offset", String(update.update_id + 1));
    try {
      await handleUpdate(ctx, update);
    } catch (e) {
      console.error("Ошибка обработки обновления:", e);
    }
  }
}

const text = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== (await webhookSecret(tokenOf(env)))) return text("forbidden", 403);
      try {
        await handleUpdate(await makeContext(env), await request.json());
      } catch (e) {
        // Отвечаем 200, иначе Telegram будет бесконечно повторять это обновление
        console.error("Ошибка обработки обновления:", e);
      }
      return text("ok");
    }

    if (url.pathname === "/setup") {
      if (!tokenOf(env)) return text("Сначала добавьте секрет BOT_TOKEN в настройках Worker.", 500);
      if ((url.searchParams.get("token") || "").trim() !== tokenOf(env)) {
        return text("Откройте адрес вида /setup?token=ВАШ_ТОКЕН_БОТА", 403);
      }
      try {
        return text(await setup(env, url.origin));
      } catch (e) {
        return text(`❌ Ошибка: ${e.message}`, 500);
      }
    }

    return text("🤖 Бот работает. Для подключения откройте /setup?token=ВАШ_ТОКЕН_БОТА");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      for (const step of [autoSetup, pollUpdates]) {
        try {
          await step(env);
        } catch (e) {
          console.error(`${step.name}:`, e);
        }
      }
      await runScheduled(await makeContext(env));
    })());
  },
};

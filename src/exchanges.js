// Тема обменов между пиццериями: «взяли в долг», «перемещение», «отдали другой пиццерии».
// Бот напоминает, что сделать (вернуть / оформить перемещение / забрать обратно), спрашивает срок
// кнопками и в срок напоминает; без ответа — каждый день, пока не нажмут «Сделано».
import { esc, fmtDt, fullName, localParts, mention, parseDeadline, threadOf } from "./utils.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BATCH = 10;
const EXCERPT = 120;
const REMIND_TIME = "12:00"; // во сколько напоминать в выбранный день и при повторах
const TODAY_TIME = "20:00"; // «сегодня» — к вечеру

// Виды обменов. Порядок важен: «дали в долг» проверяется раньше, чем «в долг».
// Слова — начала слов: «отдал» ловит «отдали», «отдала».
export const EXCHANGE_KINDS = [
  {
    kind: "transfer", emoji: "🚚", title: "Перемещение", todo: "сделать перемещение",
    ask: "Когда сделаете перемещение?",
    words: ["перемещ", "переместил", "привезли из", "привез из", "забрали из", "забрал из"],
  },
  {
    kind: "lent", emoji: "📦", title: "Отдали другой пиццерии", todo: "забрать обратно",
    ask: "Когда заберёте обратно?",
    words: ["отдал", "дали в долг", "дал в долг", "дала в долг", "одолжили им", "передали", "передал", "поделились"],
  },
  {
    kind: "borrowed", emoji: "🔁", title: "Взяли в долг", todo: "вернуть",
    ask: "Когда вернёте?",
    words: ["взяли в долг", "взял в долг", "взяла в долг", "в долг", "заняли", "занял", "одолжили у", "одолжил у",
      "взяли у", "взял у", "взяла у"],
  },
];
const KIND = Object.fromEntries(EXCHANGE_KINDS.map((k) => [k.kind, k]));

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
const excerpt = (s) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + "…" : s);

export function isExchangeTopic(ctx, chatId, threadId) {
  const t = ctx.cfg.exchangeTopic;
  return Boolean(t) && t.chatId === chatId && t.threadId === threadId;
}

// Вид обмена по тексту или null
export function detectExchange(text) {
  const t = norm(text);
  for (const k of EXCHANGE_KINDS) {
    for (const w of k.words) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${norm(w).replace(/\s+/g, "\\s+")}`, "u");
      if (re.test(t)) return k;
    }
  }
  return null;
}

// Момент «через days дней в time» по местному времени (ISO, UTC)
function localAt(tz, days, time) {
  const [y, m, d] = localParts(new Date(Date.now() + days * DAY), tz).date.split("-");
  return parseDeadline(`${d}.${m}.${y} ${time}`, tz);
}

const DUE_OPTIONS = [
  ["d0", "Сегодня"], ["d1", "Завтра"], ["d3", "Через 3 дня"], ["d7", "Через неделю"],
];
function dueFor(ctx, option) {
  const tz = ctx.cfg.timezone;
  if (option === "d0") {
    const iso = localAt(tz, 0, TODAY_TIME);
    // вечер уже прошёл — напомним через час
    return Date.parse(iso) > Date.now() ? iso : new Date(Date.now() + HOUR).toISOString().slice(0, 19) + "Z";
  }
  return localAt(tz, Number(option.slice(1)), REMIND_TIME);
}

const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const dueKeyboard = (id) => ({
  inline_keyboard: [
    DUE_OPTIONS.slice(0, 2).map(([o, t]) => btn(t, `ex:${id}:${o}`)),
    DUE_OPTIONS.slice(2).map(([o, t]) => btn(t, `ex:${id}:${o}`)),
    [btn("✅ Уже сделано", `ex:${id}:done`, "success")],
  ],
});
const remindKeyboard = (id) => ({
  inline_keyboard: [[btn("✅ Сделано", `ex:${id}:done`, "success"), btn("⏳ На завтра", `ex:${id}:d1`)]],
});

function plain(markup) {
  return { inline_keyboard: markup.inline_keyboard.map((row) => row.map(({ text, callback_data }) => ({ text, callback_data }))) };
}
async function sendWithButtons(ctx, chatId, text, opts, markup) {
  return (await ctx.tg.send(chatId, text, { ...opts, markup })) ||
    ctx.tg.send(chatId, text, { ...opts, markup: plain(markup) });
}
async function editWithButtons(ctx, chatId, messageId, text, markup) {
  return (await ctx.tg.edit(chatId, messageId, text, markup)) ||
    ctx.tg.edit(chatId, messageId, text, plain(markup));
}

function firstText(e) {
  const k = KIND[e.kind];
  return `${k.emoji} <b>${k.title}</b>\n${mention(e.user_id, e.user_name)}, <b>не забудь ${k.todo}</b>.\n\n⏰ ${k.ask}`;
}
function scheduledText(ctx, e, who) {
  const k = KIND[e.kind];
  return `${k.emoji} <b>${k.title}</b>\n${mention(e.user_id, e.user_name)}, <b>не забудь ${k.todo}</b>.\n\n` +
    `⏰ Срок: <b>${fmtDt(e.due_at, ctx.cfg.timezone)}</b> (выбрал(а) ${who}). Напомню в срок.`;
}
function remindText(e) {
  const k = KIND[e.kind];
  return `⏰ <b>Срок: ${k.todo}!</b>\n«${esc(excerpt(e.text))}» — ${mention(e.user_id, e.user_name)}\n\nСделали?`;
}

const remindIds = (e) => JSON.parse(e.remind_message_ids || "[]");

// ---------- сообщения в теме ----------

// true — сообщение обработано модулем обменов
export async function handleExchangeMessage(ctx, msg) {
  const chatId = msg.chat.id;
  const threadId = threadOf(msg);
  if (!isExchangeTopic(ctx, chatId, threadId)) return false;
  // Ответы в обсуждении уже известного обмена новый не создают
  if (msg.reply_to_message && await ctx.db.exchangeByAnyMessage(chatId, msg.reply_to_message.message_id)) return true;

  const text = msg.text || msg.caption || "";
  const k = text && detectExchange(text);
  if (!k) return false;
  const user = msg.from;
  const id = await ctx.db.createExchange({
    chatId, threadId, messageId: msg.message_id, userId: user.id, userName: fullName(user), text, kind: k.kind,
    // срок не выбрали — напомним завтра в 12:00
    dueAt: localAt(ctx.cfg.timezone, 1, REMIND_TIME),
  });
  if (!id) return true;
  const e = await ctx.db.getExchange(id);
  const sent = await sendWithButtons(ctx, chatId, firstText(e), { thread: threadId, replyTo: msg.message_id }, dueKeyboard(id));
  if (sent) await ctx.db.setExchangeBotMessage(id, sent.message_id);
  return true;
}

// Кнопки: ex:<id>:d0|d1|d3|d7 (срок), ex:<id>:done → подтверждение ex:<id>:done!:<user> / back:<user>
export async function onExchangeButton(ctx, call) {
  const [, rawId, action, ownerId] = call.data.split(":");
  const e = await ctx.db.getExchange(Number(rawId));
  const chatId = call.message.chat.id;
  const messageId = call.message.message_id;
  const name = fullName(call.from);
  const who = mention(call.from.id, name);
  if (!e) {
    await ctx.tg.answer(call.id, "Запись не найдена.", true);
    return;
  }
  if (e.status !== "open") {
    await ctx.tg.answer(call.id, "Уже отмечено как сделано.", true);
    await ctx.tg.safe("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  if (ownerId && Number(ownerId) !== call.from.id) {
    await ctx.tg.answer(call.id, "Подтвердить может только тот, кто нажал кнопку.", true);
    return;
  }
  const k = KIND[e.kind];

  if (/^d\d$/.test(action)) {
    const due = dueFor(ctx, action);
    await ctx.db.setExchangeDue(e.id, due);
    const updated = { ...e, due_at: due };
    if (messageId === e.bot_message_id) {
      await editWithButtons(ctx, chatId, messageId, scheduledText(ctx, updated, who),
        { inline_keyboard: [[btn("✅ Уже сделано", `ex:${e.id}:done`, "success")]] });
    } else {
      await ctx.tg.edit(chatId, messageId,
        `${remindText(e).replace(/\n\nСделали\?$/, "")}\n\n⏳ Перенесли на ${fmtDt(due, ctx.cfg.timezone)} (${who}).`);
    }
    await ctx.tg.answer(call.id, `Напомню ${fmtDt(due, ctx.cfg.timezone)}.`);
    return;
  }

  if (action === "done") {
    const base = messageId === e.bot_message_id ? firstText(e) : remindText(e);
    await editWithButtons(ctx, chatId, messageId,
      `${base}\n\n❓ ${who}, подтвердите: «${esc(excerpt(e.text))}» — <b>${k.todo}: сделано</b>?`,
      { inline_keyboard: [[
        btn("✅ Да, сделано", `ex:${e.id}:done!:${call.from.id}`, "success"),
        btn("↩️ Назад", `ex:${e.id}:back:${call.from.id}`),
      ]] });
    await ctx.tg.answer(call.id);
    return;
  }

  if (action === "back") {
    if (messageId === e.bot_message_id) await editWithButtons(ctx, chatId, messageId, firstText(e), dueKeyboard(e.id));
    else await editWithButtons(ctx, chatId, messageId, remindText(e), remindKeyboard(e.id));
    await ctx.tg.answer(call.id);
    return;
  }

  if (action === "done!") {
    if (!(await ctx.db.closeExchange(e.id, "done", call.from.id, name))) {
      await ctx.tg.answer(call.id, "Уже отмечено как сделано.", true);
      return;
    }
    // Напоминания больше не нужны; первое сообщение — итог
    for (const id of new Set([...remindIds(e), messageId])) {
      if (id && id !== e.bot_message_id) await ctx.tg.del(chatId, id);
    }
    if (e.bot_message_id) {
      await ctx.tg.edit(chatId, e.bot_message_id,
        `✅ <b>${k.title}: ${k.todo} — сделано</b>\n«${esc(excerpt(e.text))}» — ${mention(e.user_id, e.user_name)}\nОтметил(а): ${who}`);
    }
    await ctx.tg.answer(call.id, "Отмечено. Спасибо!");
  }
}

// ---------- команды в теме ----------

export async function handleExchangeCommand(ctx, msg, cmd) {
  const chatId = msg.chat.id;
  if (!isExchangeTopic(ctx, chatId, threadOf(msg)) || cmd !== "dolgi") return false;
  const open = await ctx.db.openExchanges(chatId);
  if (!open.length) {
    await ctx.tg.reply(msg, "🎉 Всё вернули и оформили — открытых записей нет.");
    return true;
  }
  const chat = String(chatId).replace(/^-100/, "");
  const lines = [`📋 <b>Не закрыто (${open.length})</b>`];
  for (const e of open) {
    const k = KIND[e.kind];
    lines.push(`${k.emoji} <a href="https://t.me/c/${chat}/${e.thread_id}/${e.message_id}">${esc(excerpt(e.text))}</a>` +
      ` — ${k.todo}, срок ${fmtDt(e.due_at, ctx.cfg.timezone)}`);
  }
  await ctx.tg.reply(msg, lines.join("\n").slice(0, 4000));
  return true;
}

// ---------- планировщик ----------

export async function checkExchanges(ctx) {
  const { photoRemindFrom, photoRemindTo, timezone } = ctx.cfg;
  const now = localParts(new Date(), timezone).time;
  if (now < photoRemindFrom || now > photoRemindTo) return; // ночью не беспокоим

  for (const e of await ctx.db.dueExchanges(new Date().toISOString().slice(0, 19) + "Z", BATCH)) {
    // Админ удалил сообщение бота — больше не напоминаем
    if (e.bot_message_id && await ctx.tg.messageGone(e.chat_id, e.bot_message_id,
      { inline_keyboard: [[btn("✅ Уже сделано", `ex:${e.id}:done`, "success")]] })) {
      await ctx.db.closeExchange(e.id, "cancelled", null, null);
      for (const id of remindIds(e)) await ctx.tg.del(e.chat_id, id);
      continue;
    }
    // Без ответа — напомним завтра в 12:00
    await ctx.db.setExchangeDue(e.id, localAt(timezone, 1, REMIND_TIME));
    for (const id of remindIds(e)) {
      await ctx.tg.safe("editMessageReplyMarkup", { chat_id: e.chat_id, message_id: id, reply_markup: { inline_keyboard: [] } });
    }
    const sent = await sendWithButtons(ctx, e.chat_id, remindText(e), { thread: e.thread_id, replyTo: e.message_id },
      remindKeyboard(e.id));
    if (sent) await ctx.db.addExchangeRemind(e.id, sent.message_id);
  }
}

// Закреп с подсказкой в теме (один раз)
const HELP_TEXT = `📌 <b>Тема обменов между пиццериями — как работает бот</b>

Напишите, что произошло, — бот напомнит, что сделать, и спросит срок:
🔁 «Взяли в долг …» → не забудь вернуть
🚚 «Перемещение из …» → не забудь сделать перемещение
📦 «Отдали … другой пиццерии» → не забудь забрать обратно

В срок бот напомнит; без ответа — каждый день, пока не нажмёте «✅ Сделано».
/dolgi — что ещё не закрыто`;

export async function ensureExchangeHelp(ctx) {
  const t = ctx.cfg.exchangeTopic;
  if (!t) return;
  const key = `exchange_help:${t.chatId}:${t.threadId}`;
  if (await ctx.db.getSetting(key)) return;
  const sent = await ctx.tg.send(t.chatId, HELP_TEXT, { thread: t.threadId });
  if (!sent) return;
  await ctx.db.setSetting(key, String(sent.message_id));
  await ctx.tg.safe("pinChatMessage", { chat_id: t.chatId, message_id: sent.message_id, disable_notification: true });
}

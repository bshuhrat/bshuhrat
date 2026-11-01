// Тема важных сообщений: сообщение (или пересланное) со словами «срочно», «важно» и т.п.
// Telegram не сообщает ботам, кто прочитал, поэтому прочтение подтверждают кнопкой.
// Кто не подтвердил — бот отмечает через 2 часа, затем каждые 4 часа; все прочитали — напоминания удаляются.
import { fullName, localParts, mention, threadOf } from "./utils.js";

const HOUR = 3_600_000;
const FIRST_REMIND_HOURS = 2;
const REPEAT_HOURS = 4;
const BATCH = 10;
const MENTIONS_PER_MESSAGE = 50;

// Начала слов: «срочн» ловит «срочно», «срочная»; «важн» — «важно», «важная»
export const IMPORTANT_WORDS = [
  "срочн", "важн", "внимани", "обязательн", "к сведени", "всем прочит", "прочитать всем", "прочитайте",
  "не пропустите", "‼", "❗", "🔥", "🚨",
];

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19) + "Z";

export function isImportantTopic(ctx, chatId, threadId) {
  const t = ctx.cfg.importantTopic;
  return Boolean(t) && t.chatId === chatId && t.threadId === threadId;
}

export function isImportantText(text) {
  const t = norm(text);
  return IMPORTANT_WORDS.some((w) => /^\p{L}/u.test(w)
    ? new RegExp(`(^|[^\\p{L}\\p{N}_])${norm(w).replace(/\s+/g, "\\s+")}`, "u").test(t)
    : t.includes(w));
}

const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const readKeyboard = (id) => ({ inline_keyboard: [[btn("✅ Прочитал(а)", `im:${id}:read`, "success")]] });
const plainKeyboard = (id) => ({ inline_keyboard: [[{ text: "✅ Прочитал(а)", callback_data: `im:${id}:read` }]] });

async function sendWithButton(ctx, chatId, text, opts, id) {
  return (await ctx.tg.send(chatId, text, { ...opts, markup: readKeyboard(id) })) ||
    ctx.tg.send(chatId, text, { ...opts, markup: plainKeyboard(id) });
}
async function editWithButton(ctx, chatId, messageId, text, id) {
  return (await ctx.tg.edit(chatId, messageId, text, readKeyboard(id))) ||
    ctx.tg.edit(chatId, messageId, text, plainKeyboard(id));
}

function headerText(read, total) {
  return "📢 <b>Важное сообщение — подтвердите, что прочитали</b>\n" +
    `Прочитали: ${read} из ${total}`;
}
function remindText(unread) {
  const names = unread.slice(0, MENTIONS_PER_MESSAGE).map((u) => mention(u.user_id, u.user_name)).join(", ");
  const more = unread.length > MENTIONS_PER_MESSAGE ? ` и ещё ${unread.length - MENTIONS_PER_MESSAGE}` : "";
  return `⏰ <b>Прочитайте важное сообщение</b> и нажмите «✅ Прочитал(а)»:\n${names}${more}`;
}

const remindIds = (r) => JSON.parse(r.remind_message_ids || "[]");

// ---------- новое важное сообщение ----------

export async function handleImportantMessage(ctx, msg) {
  const chatId = msg.chat.id;
  const threadId = threadOf(msg);
  if (!isImportantTopic(ctx, chatId, threadId)) return false;
  const text = msg.text || msg.caption || "";
  if (!text || !isImportantText(text)) return false;

  // Кто должен прочитать: все известные боту участники, кроме автора
  const recipients = (await ctx.db.listMembers(chatId)).filter((m) => m.user_id !== msg.from.id);
  const id = await ctx.db.createImportant({
    chatId, threadId, messageId: msg.message_id, authorId: msg.from.id,
    nextAt: isoIn(FIRST_REMIND_HOURS * HOUR), recipients,
  });
  if (!id) return true;
  const sent = await sendWithButton(ctx, chatId, headerText(0, recipients.length),
    { thread: threadId, replyTo: msg.message_id }, id);
  if (sent) await ctx.db.setImportantBotMessage(id, sent.message_id);
  return true;
}

// ---------- кнопка «Прочитал(а)» ----------

async function finishIfAllRead(ctx, item) {
  const reads = await ctx.db.importantReads(item.id);
  const unread = reads.filter((r) => !r.read_at);
  const total = reads.length;
  if (!unread.length) {
    await ctx.db.closeImportant(item.id, "done");
    for (const id of remindIds(item)) await ctx.tg.del(item.chat_id, id);
    if (item.bot_message_id) {
      await ctx.tg.edit(item.chat_id, item.bot_message_id, `✅ <b>Все прочитали</b> (${total} из ${total})`);
    }
    return;
  }
  if (item.bot_message_id) {
    await editWithButton(ctx, item.chat_id, item.bot_message_id, headerText(total - unread.length, total), item.id);
  }
  // В последнем напоминании оставляем только тех, кто ещё не прочитал
  const last = remindIds(item).at(-1);
  if (last) await editWithButton(ctx, item.chat_id, last, remindText(unread), item.id);
}

export async function onImportantButton(ctx, call) {
  const item = await ctx.db.getImportant(Number(call.data.split(":")[1]));
  if (!item) {
    await ctx.tg.answer(call.id, "Сообщение не найдено.", true);
    return;
  }
  if (item.status !== "open") {
    await ctx.tg.answer(call.id, "Спасибо! Все уже прочитали.");
    return;
  }
  if (call.from.id === item.author_id) {
    await ctx.tg.answer(call.id, "Вы автор этого сообщения — вам подтверждать не нужно.");
    return;
  }
  const marked = await ctx.db.markImportantRead(item.id, call.from.id, fullName(call.from));
  await ctx.tg.answer(call.id, marked ? "Спасибо, отмечено!" : "Вы уже отметили, спасибо.");
  if (marked) await finishIfAllRead(ctx, await ctx.db.getImportant(item.id));
}

// ---------- напоминания (планировщик) ----------

export async function checkImportant(ctx) {
  const { photoRemindFrom, photoRemindTo, timezone } = ctx.cfg;
  const now = localParts(new Date(), timezone).time;
  if (now < photoRemindFrom || now > photoRemindTo) return; // ночью не беспокоим

  for (const item of await ctx.db.dueImportant(isoIn(0), BATCH)) {
    // Админ удалил сообщение бота — больше не напоминаем
    if (item.bot_message_id && await ctx.tg.messageGone(item.chat_id, item.bot_message_id, readKeyboard(item.id))) {
      await ctx.db.closeImportant(item.id, "cancelled");
      for (const id of remindIds(item)) await ctx.tg.del(item.chat_id, id);
      continue;
    }
    const unread = (await ctx.db.importantReads(item.id)).filter((r) => !r.read_at);
    if (!unread.length) {
      await finishIfAllRead(ctx, item);
      continue;
    }
    await ctx.db.setImportantNext(item.id, isoIn(REPEAT_HOURS * HOUR));
    // Кнопка — только на последнем напоминании
    for (const id of remindIds(item)) {
      await ctx.tg.safe("editMessageReplyMarkup", { chat_id: item.chat_id, message_id: id, reply_markup: { inline_keyboard: [] } });
    }
    const sent = await sendWithButton(ctx, item.chat_id, remindText(unread),
      { thread: item.thread_id, replyTo: item.message_id }, item.id);
    if (sent) await ctx.db.addImportantRemind(item.id, sent.message_id);
  }
}

// ---------- закреп с подсказкой ----------

const HELP_TEXT = `📌 <b>Тема важных сообщений — как работает бот</b>

Если в сообщении (или пересланном) есть «срочно», «важно», «внимание», «обязательно» или ‼️ — бот попросит всех подтвердить прочтение кнопкой «✅ Прочитал(а)».

Кто не подтвердил — бот отметит через 2 часа, затем каждые 4 часа (ночью не пишет). Когда все прочитали, напоминания удаляются.`;

export async function ensureImportantHelp(ctx) {
  const t = ctx.cfg.importantTopic;
  if (!t) return;
  const key = `important_help:${t.chatId}:${t.threadId}`;
  if (await ctx.db.getSetting(key)) return;
  const sent = await ctx.tg.send(t.chatId, HELP_TEXT, { thread: t.threadId });
  if (!sent) return;
  await ctx.db.setSetting(key, String(sent.message_id));
  await ctx.tg.safe("pinChatMessage", { chat_id: t.chatId, message_id: sent.message_id, disable_notification: true });
}

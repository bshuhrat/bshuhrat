// Тема поломок: бот замечает сообщения о поломках, просит оформить заявку во внешней системе
// и потом уточняет статус — через 48 ч, затем каждые 7 дней, пока не ответят «починили».
import { esc, fullName, localParts, mention, threadOf } from "./utils.js";

// Начала слов и фраз о поломках в пиццерии: «слома» ловит «сломалась», «сломался», «сломали»…
export const DEFAULT_REPAIR_KEYWORDS = [
  // общее
  "слома", "поломк", "неисправ", "не работает", "не работают", "не работал", "перестал",
  "барахлит", "ремонт", "сбой",
  // нагрев и холод: печь, холодильники, морозилки
  "не включа", "не включил", "не выключа", "не греет", "не нагрева", "не разогрева", "плохо греет",
  "не печет", "не пропека", "не охлажда", "плохо охлажда", "не морозит", "не холодит",
  "не держит температур",
  // электрика
  "сгорел", "перегор", "искрит", "коротит", "замыкани", "выбивает", "выбило", "нет света",
  "нет электричеств", "моргает", "мигает",
  // вода и канализация
  "течет", "протека", "протек", "капает", "лужа", "засор", "забился", "забилась", "не сливает",
  "не смывает", "нет воды", "нет горячей воды", "прорвал", "потоп",
  // газ
  "запах газа", "пахнет газом", "утечк",
  // механика и мебель
  "заклинил", "клинит", "не крутит", "не вращает", "гудит", "скрипит", "трещин", "треснул",
  "разбил", "отвалил", "оторвал", "шатается", "не открывает", "не закрывает",
  // оборудование пиццерии
  "печь не", "тестомес не", "холодильник не", "морозилка не", "морозильник не", "вытяжка не",
  "вентиляция не", "кондиционер не", "посудомойка не", "посудомоечная не", "фритюр не",
  "миксер не", "раскатка не", "слайсер не", "весы не",
  // касса и техника
  "касса не", "терминал не", "принтер не", "не печатает", "не пробивает", "нет интернета",
  "интернет не", "вайфай не", "wi-fi не", "зависает", "завис", "глючит",
];

const EXCERPT = 120;
const CHECK_BATCH = 10; // проверок статуса за один запуск планировщика

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
const excerpt = (s) => (s.length > EXCERPT ? s.slice(0, EXCERPT) + "…" : s);
const isoIn = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19) + "Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function isRepairTopic(ctx, chatId, threadId) {
  const t = ctx.cfg.repairTopic;
  return Boolean(t) && t.chatId === chatId && t.threadId === threadId;
}

// Ключевое слово, найденное в тексте (начало слова + любое окончание), или null
export function findRepairKeyword(text, keywords) {
  const t = norm(text);
  for (const kw of keywords) {
    const k = norm(kw).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (k && new RegExp(`(^|[^\\p{L}\\p{N}_])${k}`, "u").test(t)) return kw;
  }
  return null;
}

export async function repairKeywords(ctx, chatId) {
  const custom = await ctx.db.repairKeywordRows(chatId);
  const off = new Set(custom.filter((r) => !r.enabled).map((r) => r.keyword));
  const added = custom.filter((r) => r.enabled).map((r) => r.keyword);
  return [...new Set([...DEFAULT_REPAIR_KEYWORDS, ...added])].filter((k) => !off.has(k));
}

function messageLink(chatId, threadId, messageId) {
  const chat = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${chat}/${threadId ? `${threadId}/` : ""}${messageId}`;
}

function age(fromIso) {
  const ms = Date.now() - Date.parse(fromIso);
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return d ? `${d} дн. ${h} ч` : `${h} ч`;
}

// ---------- тексты и кнопки ----------

const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });

function firstText(ctx, r) {
  const url = ctx.cfg.repairSystemUrl;
  const where = url ? ` в системе: <a href="${esc(url)}">оформить заявку</a>` : " в системе заявок";
  return `🛠 <b>Нужна заявка №${r.id}</b>\n` +
    `Похоже на поломку («${esc(r.keyword)}»).\n` +
    `${mention(r.user_id, r.user_name)}, пожалуйста, <b>оформите заявку</b>${where}.\n\n` +
    `Через ${ctx.cfg.repairFirstCheckHours} ч я уточню, починили ли.`;
}
const firstKeyboard = (id) => ({
  inline_keyboard: [[btn("✅ Уже починили", `rp:${id}:fixed`), btn("❌ Это не поломка", `rp:${id}:notbug`)]],
});

function checkText(r) {
  return `⏰ <b>Заявка №${r.id} — какой статус?</b>\n` +
    `«${esc(excerpt(r.text))}» — ${mention(r.user_id, r.user_name)}\n` +
    `Прошло: ${age(r.created_at)}\n\nПочинили?`;
}
const checkKeyboard = (id) => ({
  inline_keyboard: [[btn("✅ Починили", `rp:${id}:fixed`, "success"), btn("🛠 Ещё нет", `rp:${id}:notyet`)]],
});

const ACTION_QUESTION = { fixed: "<b>починили</b>", notbug: "<b>это не поломка</b>" };
const ACTION_CONFIRM = { fixed: "✅ Да, починили", notbug: "✅ Да, не поломка" };

// Отправка/правка с цветными кнопками; без цвета, если Telegram их не принял
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

// ---------- сообщения в теме ----------

// true — сообщение обработано модулем поломок
export async function handleRepairMessage(ctx, msg) {
  const chatId = msg.chat.id;
  const threadId = threadOf(msg);
  if (!isRepairTopic(ctx, chatId, threadId)) return false;

  // Ответы в обсуждении уже известной поломки новую заявку не создают
  if (msg.reply_to_message) {
    const related = await ctx.db.repairByAnyMessage(chatId, msg.reply_to_message.message_id);
    if (related) {
      // Фото «после ремонта» — ответом на сообщение о закрытии (по желанию)
      if (msg.photo && related.status === "fixed" && related.close_message_id === msg.reply_to_message.message_id) {
        await ctx.db.setRepairPhoto(related.id, msg.photo.at(-1).file_id);
        await ctx.tg.reply(msg, `📸 Спасибо! Фото после ремонта добавлено к заявке №${related.id}.`);
      }
      return true;
    }
  }

  const text = msg.text || msg.caption || "";
  if (!text) return false;
  const keyword = findRepairKeyword(text, await repairKeywords(ctx, chatId));
  if (!keyword) return false;

  const user = msg.from;
  const id = await ctx.db.createRepair({
    chatId, threadId, messageId: msg.message_id, userId: user.id, userName: fullName(user),
    text, keyword, nextCheckAt: isoIn(ctx.cfg.repairFirstCheckHours * HOUR),
  });
  if (!id) return true; // это сообщение уже зарегистрировано
  const r = await ctx.db.getRepair(id);
  const sent = await sendWithButtons(ctx, chatId, firstText(ctx, r),
    { thread: threadId, replyTo: msg.message_id }, firstKeyboard(id));
  if (sent) await ctx.db.setRepairBotMessage(id, sent.message_id);
  return true;
}

// Текст сообщения, на котором нажали кнопку, и его кнопки — чтобы вернуть по «Назад»
function messageState(ctx, r, messageId) {
  if (messageId === r.bot_message_id) return { text: firstText(ctx, r), markup: firstKeyboard(r.id) };
  return { text: checkText(r), markup: checkKeyboard(r.id) };
}

// Кнопки: rp:<id>:fixed | notbug | notyet — и подтверждение rp:<id>:<действие>!:<user> / back:<user>
export async function onRepairButton(ctx, call) {
  const [, rawId, action, ownerId] = call.data.split(":");
  const r = await ctx.db.getRepair(Number(rawId));
  const chatId = call.message.chat.id;
  const messageId = call.message.message_id;
  const name = fullName(call.from);
  if (!r) {
    await ctx.tg.answer(call.id, "Заявка не найдена.", true);
    return;
  }
  if (r.status !== "open") {
    await ctx.tg.answer(call.id, `Заявка №${r.id} уже закрыта.`, true);
    await ctx.tg.safe("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  // Подтверждение и «Назад» — только тот, кто начал, чтобы никто не перепутал
  if (ownerId && Number(ownerId) !== call.from.id) {
    await ctx.tg.answer(call.id, "Подтвердить может только тот, кто нажал кнопку.", true);
    return;
  }
  const state = messageState(ctx, r, messageId);

  if (action === "fixed" || action === "notbug") {
    await editWithButtons(ctx, chatId, messageId,
      `${state.text}\n\n❓ ${mention(call.from.id, name)}, подтвердите: заявка <b>№${r.id}</b> ` +
        `(«${esc(excerpt(r.text))}») — ${ACTION_QUESTION[action]}?`,
      { inline_keyboard: [[
        btn(ACTION_CONFIRM[action], `rp:${r.id}:${action}!:${call.from.id}`, "success"),
        btn("↩️ Назад", `rp:${r.id}:back:${call.from.id}`),
      ]] });
    await ctx.tg.answer(call.id);
    return;
  }

  if (action === "back") {
    await editWithButtons(ctx, chatId, messageId, state.text, state.markup);
    await ctx.tg.answer(call.id);
    return;
  }

  if (action === "notyet") {
    const next = isoIn(ctx.cfg.repairRepeatDays * DAY);
    await ctx.db.setRepairNextCheck(r.id, next);
    await ctx.tg.edit(chatId, messageId,
      `${checkText(r).replace(/\n\nПочинили\?$/, "")}\n\n🛠 <b>Ещё не починили</b> — отметил(а) ${mention(call.from.id, name)}.\n` +
        `Уточню снова через ${ctx.cfg.repairRepeatDays} дн.`);
    await ctx.tg.answer(call.id, "Отмечено: ещё не починили.");
    return;
  }

  if (action === "fixed!") {
    if (!(await ctx.db.closeRepair(r.id, "fixed", call.from.id, name, messageId))) {
      await ctx.tg.answer(call.id, `Заявка №${r.id} уже закрыта.`, true);
      return;
    }
    await ctx.tg.edit(chatId, messageId,
      `✅ <b>Заявка №${r.id} — починили</b>\n` +
        `«${esc(excerpt(r.text))}» — ${mention(r.user_id, r.user_name)}\n` +
        `Отметил(а): ${mention(call.from.id, name)} · была открыта ${age(r.created_at)}\n\n` +
        "📸 По желанию: пришлите фото после ремонта ответом на это сообщение.");
    // У остальных сообщений заявки кнопки больше не нужны
    for (const id of new Set([r.bot_message_id, r.check_message_id])) {
      if (id && id !== messageId) {
        await ctx.tg.safe("editMessageReplyMarkup", { chat_id: chatId, message_id: id, reply_markup: { inline_keyboard: [] } });
      }
    }
    await ctx.tg.answer(call.id, `Заявка №${r.id} закрыта. Спасибо!`);
    return;
  }

  if (action === "notbug!") {
    if (!(await ctx.db.closeRepair(r.id, "rejected", call.from.id, name, null))) {
      await ctx.tg.answer(call.id, `Заявка №${r.id} уже закрыта.`, true);
      return;
    }
    // Ложное срабатывание — убираем сообщения бота, чтобы не мешали
    for (const id of new Set([r.bot_message_id, r.check_message_id, messageId])) {
      if (id) await ctx.tg.del(chatId, id);
    }
    await ctx.tg.answer(call.id, "Понял, это не поломка.");
  }
}

// ---------- команды в теме поломок ----------

export async function handleRepairCommand(ctx, msg, cmd, args, admin) {
  const chatId = msg.chat.id;
  if (!isRepairTopic(ctx, chatId, threadOf(msg))) return false;
  const tg = ctx.tg;

  if (cmd === "zayavki" || cmd === "repairs") {
    const open = await ctx.db.openRepairs(chatId);
    if (!open.length) {
      await tg.reply(msg, "🎉 Открытых заявок нет.");
      return true;
    }
    const lines = [`🛠 <b>Открытые заявки (${open.length})</b>`];
    for (const r of open) {
      lines.push(`• <a href="${messageLink(chatId, r.thread_id, r.message_id)}">№${r.id}</a> ` +
        `«${esc(excerpt(r.text))}» — ${esc(r.user_name)}, открыта ${age(r.created_at)}`);
    }
    await tg.reply(msg, lines.join("\n").slice(0, 4000));
    return true;
  }

  if (cmd === "kw") {
    const list = await repairKeywords(ctx, chatId);
    await tg.reply(msg, `🔑 <b>Слова, на которые бот реагирует (${list.length})</b>\n` +
      esc(list.join(", ")).slice(0, 3800) +
      (admin ? "\n\nДобавить: <code>/kw_add слово</code>\nУбрать: <code>/kw_del слово</code>" : ""));
    return true;
  }

  if ((cmd === "kw_add" || cmd === "kw_del") && admin) {
    const kw = norm(args).trim();
    if (!kw) {
      await tg.reply(msg, `Использование: <code>/${cmd} не работает</code>`);
      return true;
    }
    await ctx.db.setRepairKeyword(chatId, kw, cmd === "kw_add");
    await tg.reply(msg, cmd === "kw_add"
      ? `✅ Теперь бот реагирует на «${esc(kw)}».`
      : `🗑 Бот больше не реагирует на «${esc(kw)}».`);
    return true;
  }
  return false;
}

// ---------- планировщик: уточнение статуса ----------

export async function checkRepairs(ctx) {
  const { photoRemindFrom, photoRemindTo, timezone, repairRepeatDays } = ctx.cfg;
  const now = localParts(new Date(), timezone).time;
  if (now < photoRemindFrom || now > photoRemindTo) return; // ночью не беспокоим

  for (const r of await ctx.db.dueRepairs(isoIn(0), CHECK_BATCH)) {
    // Следующая проверка — через 7 дней, если на эту не ответят
    await ctx.db.setRepairNextCheck(r.id, isoIn(repairRepeatDays * DAY));
    if (r.check_message_id) {
      await ctx.tg.safe("editMessageReplyMarkup", {
        chat_id: r.chat_id, message_id: r.check_message_id, reply_markup: { inline_keyboard: [] },
      });
    }
    const sent = await sendWithButtons(ctx, r.chat_id, checkText(r),
      { thread: r.thread_id, replyTo: r.message_id }, checkKeyboard(r.id));
    if (sent) await ctx.db.setRepairCheckMessage(r.id, sent.message_id);
  }
}

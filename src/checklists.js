// Чек-листы: шаблоны для темы, ежедневная публикация, постраничный просмотр,
// отметки пунктов кнопками и одно напоминание после дедлайна.
import { ensureDefaultChecklist } from "./default-checklist.js";
import { isChatAdmin } from "./photofix.js";
import { esc, fmtDt, fullName, localParts, mention, nowIso, parseDeadline, splitArgs, threadOf } from "./utils.js";

const BATCH = 10;
const MAX_ITEMS = 60;
const MAX_ITEM_LENGTH = 350;
const MAX_TOTAL_ITEMS_LENGTH = 10_000;
const PAGE_SIZE = 6;
const MIN_DUE_MINUTES = 5;
const MAX_DUE_MINUTES = 240;

const KINDS = {
  opening: { emoji: "☀️", title: "открытия", accusative: "открытие" },
  closing: { emoji: "🌙", title: "закрытия", accusative: "закрытие" },
};
const KIND_ALIASES = {
  открытие: "opening", открытия: "opening", opening: "opening", open: "opening",
  закрытие: "closing", закрытия: "closing", closing: "closing", close: "closing",
};

const kindOf = (value) => KIND_ALIASES[String(value || "").toLowerCase()] || null;
const itemsOf = (row) => JSON.parse(row.items || "[]");
const itemText = (item) => typeof item === "string" ? item : String(item?.text || "");
const itemSection = (item) => typeof item === "object" && item ? String(item.section || "") : "";
const checksMap = (checks) => new Map(checks.map((c) => [c.item_index, c]));
const shortName = (name) => String(name || "Участник").length > 24 ?
  `${String(name).slice(0, 23)}…` : String(name || "Участник");
const isoNow = () => nowIso();
const titleOf = (row) => row.title || `Чек-лист ${KINDS[row.kind]?.title || "смены"}`;
const pageCount = (run) => Math.max(1, Math.ceil(itemsOf(run).length / PAGE_SIZE));
const safePage = (run, page) => {
  const count = pageCount(run);
  const n = Number.isInteger(page) ? page : 0;
  return ((n % count) + count) % count;
};
const pageEntries = (run, page) => itemsOf(run)
  .map((item, index) => ({ item, index }))
  .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

function localAt(date, time, timezone) {
  const [y, m, d] = date.split("-");
  return parseDeadline(`${d}.${m}.${y} ${time}`, timezone);
}

function validTime(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function parseItems(raw) {
  const items = String(raw || "").split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return { error: "Добавьте хотя бы один пункт после символа <code>|</code>." };
  if (items.length > MAX_ITEMS) return { error: `В одном чек-листе может быть не больше ${MAX_ITEMS} пунктов.` };
  if (items.some((s) => s.length > MAX_ITEM_LENGTH)) {
    return { error: `Каждый пункт должен быть короче ${MAX_ITEM_LENGTH + 1} символов.` };
  }
  if (items.reduce((sum, s) => sum + s.length, 0) > MAX_TOTAL_ITEMS_LENGTH) {
    return { error: "Слишком длинный чек-лист: сократите общий текст пунктов до 10000 символов." };
  }
  return { items };
}

const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });

function keyboard(run, checks, rawPage = 0) {
  if (run.status !== "open") return { inline_keyboard: [] };
  const page = safePage(run, rawPage);
  const checked = checksMap(checks);
  const rows = pageEntries(run, page).map(({ item, index }) => {
    const done = checked.has(index);
    const text = itemText(item);
    const short = text.length > 44 ? `${text.slice(0, 43)}…` : text;
    return [btn(`${done ? "✅" : "☐"} ${index + 1}. ${short}`, `cl:${run.id}:i:${index}:${page}`, done ? "success" : null)];
  });
  if (pageCount(run) > 1) {
    rows.push([
      btn("◀️", `cl:${run.id}:p:${page - 1}`),
      btn(`${page + 1} / ${pageCount(run)}`, `cl:${run.id}:p:${page}`),
      btn("▶️", `cl:${run.id}:p:${page + 1}`),
    ]);
  }
  return { inline_keyboard: rows };
}

function plain(markup) {
  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map(({ text, callback_data }) => ({ text, callback_data }))),
  };
}

async function sendWithButtons(ctx, chatId, text, opts, markup) {
  return (await ctx.tg.send(chatId, text, { ...opts, markup })) ||
    ctx.tg.send(chatId, text, { ...opts, markup: plain(markup) });
}

async function editWithButtons(ctx, run, text, checks, page = 0) {
  const markup = keyboard(run, checks, page);
  return (await ctx.tg.edit(run.chat_id, run.message_id, text, markup)) ||
    ctx.tg.edit(run.chat_id, run.message_id, text, plain(markup));
}

function runText(ctx, run, checks, rawPage = 0) {
  const meta = KINDS[run.kind] || { emoji: "📋" };
  const page = safePage(run, rawPage);
  const checked = checksMap(checks);
  const items = itemsOf(run);
  const lines = [
    `${meta.emoji} <b>${esc(titleOf(run))}</b> · ${esc(run.local_date)}`,
    `Выполнено: <b>${checks.length} из ${items.length}</b> · срок: ${fmtDt(run.due_at, ctx.cfg.timezone)}`,
  ];
  if (pageCount(run) > 1) lines.push(`Страница ${page + 1} из ${pageCount(run)}`);

  let section = "";
  for (const { item, index } of pageEntries(run, page)) {
    const currentSection = itemSection(item);
    if (currentSection && currentSection !== section) {
      section = currentSection;
      lines.push("", `📌 <b>${esc(section)}</b>`);
    }
    const check = checked.get(index);
    lines.push(`${check ? "✅" : "⬜"} <b>${index + 1}.</b> ${esc(itemText(item))}`);
    if (check) lines.push(`   ${mention(check.user_id, shortName(check.user_name))} · ${fmtDt(check.checked_at, ctx.cfg.timezone)}`);
  }
  if (run.status === "done") {
    lines.push("", `🎉 <b>Всё выполнено.</b> Завершил(а): ${mention(run.completed_by_id, shortName(run.completed_by_name))}`);
  } else if (run.status === "cancelled") {
    lines.push("", "🚫 <b>Чек-лист отменён.</b>");
  } else {
    lines.push("", "Нажмите на пункт после выполнения. Повторное нажатие снимет отметку." +
      (pageCount(run) > 1 ? " Переходы ◀️ ▶️ открывают другие пункты." : ""));
  }
  return lines.join("\n");
}

async function publishRun(ctx, run) {
  const sent = await sendWithButtons(ctx, run.chat_id, runText(ctx, run, []),
    { thread: run.thread_id }, keyboard(run, []));
  if (sent) await ctx.db.setChecklistRunMessage(run.id, sent.message_id);
  return sent;
}

// Создаёт запуск на сегодня. Планировщик и ручной запуск используют один путь,
// а уникальный индекс не даёт опубликовать один шаблон дважды в тот же день.
async function startRun(ctx, template, scheduled) {
  const localDate = localParts(new Date(), ctx.cfg.timezone).date;
  // Отменённый вручную или удалением сообщения запуск не возрождаем в тот же день.
  if (scheduled && await ctx.db.checklistAnyRunForDate(template.id, localDate)) {
    return { run: null, created: false };
  }
  const existing = await ctx.db.checklistRunForDate(template.id, localDate);
  if (existing) return { run: existing, created: false };
  const start = scheduled ? localAt(localDate, template.start_time, ctx.cfg.timezone) : isoNow();
  const dueAt = new Date(Date.parse(start) + template.due_minutes * 60_000).toISOString().slice(0, 19) + "Z";
  const id = await ctx.db.createChecklistRun(template, localDate, dueAt);
  if (!id) return { run: await ctx.db.checklistRunForDate(template.id, localDate), created: false };
  const run = await ctx.db.getChecklistRun(id);
  await publishRun(ctx, run);
  return { run: await ctx.db.getChecklistRun(id), created: true };
}

function usage() {
  return "Настройка чек-листа:\n" +
    "<code>/checklist_set открытие 09:00 45 | Проверить оборудование; Подготовить зал</code>\n" +
    "<code>/checklist_set закрытие 22:00 30 | Помыть поверхности; Выключить оборудование</code>\n\n" +
    "Время — ежедневная публикация, следующее число — срок в минутах (5–240). " +
    `До ${MAX_ITEMS} пунктов, разделитель — <code>;</code> или новая строка.`;
}

async function showStatus(ctx, msg) {
  const templates = await ctx.db.checklistTemplates(msg.chat.id, threadOf(msg));
  if (!templates.length) {
    await ctx.tg.reply(msg, "В этой теме чек-листы ещё не настроены.\n\n" + usage());
    return;
  }
  const today = localParts(new Date(), ctx.cfg.timezone).date;
  const lines = ["📋 <b>Чек-листы этой темы</b>"];
  for (const template of templates) {
    const run = await ctx.db.checklistRunForDate(template.id, today);
    const items = itemsOf(template);
    let state = "сегодня ещё не публиковался";
    if (run) {
      const checks = await ctx.db.checklistChecks(run.id);
      state = run.status === "open" ? `выполнено ${checks.length} из ${items.length}` :
        run.status === "done" ? "✅ выполнен" : "отменён";
    }
    lines.push(`\n<b>${esc(titleOf(template))}</b> — ${state}`);
    lines.push(`Публикация: ${template.start_time} · срок ${template.due_minutes} мин. · ` +
      (template.enabled ? "расписание включено" : "расписание выключено"));
    const sections = [...new Set(items.map(itemSection).filter(Boolean))];
    if (sections.length) lines.push(`Разделы: ${esc(sections.join(" · "))}`);
    items.slice(0, 5).forEach((item, i) => {
      const text = itemText(item);
      lines.push(`${i + 1}. ${esc(text.length > 100 ? `${text.slice(0, 99)}…` : text)}`);
    });
    if (items.length > 5) lines.push(`… и ещё ${items.length - 5} пункт(ов).`);
  }
  await ctx.tg.reply(msg, lines.join("\n").slice(0, 4000));
}

// Команды участников и администраторов. Настройкой могут управлять ADMIN_IDS и админы группы.
export async function handleChecklistCommand(ctx, msg, cmd, args, admin) {
  if (cmd === "checklists" || cmd === "checklist_status") {
    await showStatus(ctx, msg);
    return true;
  }
  const known = ["checklist", "checklist_set", "checklist_cancel", "checklist_off", "checklist_on"];
  if (!known.includes(cmd)) return false;
  if (!(admin || await isChatAdmin(ctx, msg.chat.id, msg.from.id))) {
    await ctx.tg.reply(msg, "Настраивать и запускать чек-листы могут только администраторы.");
    return true;
  }

  const chatId = msg.chat.id;
  const threadId = threadOf(msg);

  if (cmd === "checklist_set") {
    const [head, rawItems] = splitArgs(args, 2);
    const match = head.match(/^(\S+)\s+(\S+)(?:\s+(\d+))?$/);
    const kind = match ? kindOf(match[1]) : null;
    const startTime = match ? validTime(match[2]) : null;
    const dueMinutes = match?.[3] ? Number(match[3]) : 45;
    if (!kind || !startTime || dueMinutes < MIN_DUE_MINUTES || dueMinutes > MAX_DUE_MINUTES) {
      await ctx.tg.reply(msg, usage());
      return true;
    }
    const parsed = parseItems(rawItems);
    if (parsed.error) {
      await ctx.tg.reply(msg, parsed.error + "\n\n" + usage());
      return true;
    }
    await ctx.db.upsertChecklistTemplate({
      chatId, threadId, kind, items: parsed.items, startTime, dueMinutes,
    });
    await ctx.tg.reply(msg,
      `✅ Чек-лист ${KINDS[kind].title} сохранён: ${parsed.items.length} пункт(ов).\n` +
      `Ежедневно в <b>${startTime}</b>, срок — <b>${dueMinutes} мин.</b>\n` +
      `Запустить сейчас: <code>/checklist ${KINDS[kind].accusative}</code>`);
    return true;
  }

  const kind = kindOf(args);
  if (!kind) {
    await ctx.tg.reply(msg, `Укажите «открытие» или «закрытие», например: <code>/${cmd} открытие</code>`);
    return true;
  }
  const template = await ctx.db.checklistTemplate(chatId, threadId, kind);
  if (!template) {
    await ctx.tg.reply(msg, `Чек-лист ${KINDS[kind].title} в этой теме ещё не настроен.\n\n` + usage());
    return true;
  }

  if (cmd === "checklist_off" || cmd === "checklist_on") {
    const enabled = cmd === "checklist_on";
    await ctx.db.setChecklistTemplateEnabled(template.id, enabled);
    await ctx.tg.reply(msg, enabled
      ? `✅ Автоматическая публикация чек-листа ${KINDS[kind].title} включена (${template.start_time}).`
      : `⏸ Автоматическая публикация чек-листа ${KINDS[kind].title} выключена. Уже опубликованный чек-лист остаётся активным.`);
    return true;
  }

  if (cmd === "checklist_cancel") {
    const run = await ctx.db.openChecklistRun(template.id);
    if (!run) {
      await ctx.tg.reply(msg, `Сейчас нет активного чек-листа ${KINDS[kind].title}.`);
      return true;
    }
    await ctx.db.cancelChecklistRun(run.id);
    const cancelled = { ...run, status: "cancelled" };
    const checks = await ctx.db.checklistChecks(run.id);
    if (run.message_id) await editWithButtons(ctx, cancelled, runText(ctx, cancelled, checks), checks);
    await ctx.tg.reply(msg, `🚫 Чек-лист ${KINDS[kind].title} отменён. Теперь его можно запустить заново.`);
    return true;
  }

  const { run, created } = await startRun(ctx, template, false);
  if (created) {
    await ctx.tg.reply(msg, run.message_id
      ? `✅ ${esc(titleOf(template))} опубликован.`
      : "Не удалось опубликовать чек-лист — проверьте права бота.");
  } else if (run.status === "done") {
    await ctx.tg.reply(msg, `${esc(titleOf(template))} сегодня уже выполнен.`);
  } else {
    await ctx.tg.reply(msg, `${esc(titleOf(template))} уже опубликован — отмечайте пункты в его сообщении.`);
  }
  return true;
}

// Новые кнопки: cl:<run>:i:<item>:<page> и cl:<run>:p:<page>.
// Старые cl:<run>:<item> продолжают работать для уже опубликованных чек-листов.
export async function onChecklistButton(ctx, call) {
  const parts = call.data.split(":");
  const run = await ctx.db.getChecklistRun(Number(parts[1]));
  if (!run || run.chat_id !== call.message.chat.id) {
    await ctx.tg.answer(call.id, "Чек-лист не найден.", true);
    return;
  }
  if (run.status !== "open") {
    await ctx.tg.answer(call.id, run.status === "done" ? "Чек-лист уже выполнен." : "Чек-лист отменён.", true);
    return;
  }
  const checks = await ctx.db.checklistChecks(run.id);
  if (parts[2] === "p") {
    const page = safePage(run, Number(parts[3]));
    await editWithButtons(ctx, run, runText(ctx, run, checks, page), checks, page);
    await ctx.tg.answer(call.id, `Страница ${page + 1} из ${pageCount(run)}`);
    return;
  }

  const legacy = parts[2] !== "i";
  const index = Number(legacy ? parts[2] : parts[3]);
  const page = legacy ? Math.floor(index / PAGE_SIZE) : safePage(run, Number(parts[4]));
  if (!Number.isInteger(index) || index < 0 || index >= itemsOf(run).length) {
    await ctx.tg.answer(call.id, "Пункт не найден.", true);
    return;
  }
  const checked = await ctx.db.toggleChecklistItem(run.id, index, call.from.id, fullName(call.from));
  const updatedChecks = await ctx.db.checklistChecks(run.id);
  if (updatedChecks.length === itemsOf(run).length) {
    if (await ctx.db.completeChecklistRun(run.id, call.from.id, fullName(call.from))) {
      const done = await ctx.db.getChecklistRun(run.id);
      await editWithButtons(ctx, done, runText(ctx, done, updatedChecks, page), updatedChecks, page);
      if (run.reminder_message_id) await ctx.tg.del(run.chat_id, run.reminder_message_id);
    }
  } else {
    await editWithButtons(ctx, run, runText(ctx, run, updatedChecks, page), updatedChecks, page);
  }
  await ctx.tg.answer(call.id, checked ? "Пункт отмечен." : "Отметка снята.");
}

// Планировщик: публикация по местному времени и одно напоминание после срока.
export async function checkChecklists(ctx) {
  await ensureDefaultChecklist(ctx);
  const local = localParts(new Date(), ctx.cfg.timezone);
  for (const template of await ctx.db.enabledChecklistTemplates()) {
    if (local.time >= template.start_time) await startRun(ctx, template, true);
  }

  for (const run of await ctx.db.dueChecklistRuns(isoNow(), BATCH)) {
    const checks = await ctx.db.checklistChecks(run.id);
    if (run.message_id && await ctx.tg.messageGone(run.chat_id, run.message_id, plain(keyboard(run, checks)))) {
      await ctx.db.cancelChecklistRun(run.id);
      continue;
    }
    const checked = checksMap(checks);
    const missing = itemsOf(run).map((item, index) => ({ item, index }))
      .filter(({ index }) => !checked.has(index));
    const lines = [
      `⏰ <b>Срок: ${esc(titleOf(run))}</b>`,
      `Выполнено ${checks.length} из ${itemsOf(run).length}.`,
      "",
      "<b>Осталось:</b>",
      ...missing.slice(0, 5).map(({ item, index }) => `⬜ ${index + 1}. ${esc(itemText(item))}`),
    ];
    if (missing.length > 5) lines.push(`… и ещё ${missing.length - 5}. Откройте сообщение чек-листа, чтобы продолжить.`);
    const sent = await ctx.tg.send(run.chat_id, lines.join("\n"),
      { thread: run.thread_id, replyTo: run.message_id });
    await ctx.db.markChecklistRunReminded(run.id, sent?.message_id || null);
  }
}

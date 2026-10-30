// Личный чат с администратором: проверка работ, ответы на запросы, статистика.
import { commentKeyboard } from "./keyboards.js";
import { closeTask, sendLong } from "./services.js";
import { exportCsv, fullReport, taskSummary } from "./stats.js";
import { esc, fmtDt, mention, parseCommand } from "./utils.js";

const HELP = `👋 <b>Панель администратора</b>

/stats — общая статистика и рейтинг участников
/stat <i>id</i> — подробно по заданию
/pending — работы, ожидающие проверки
/requests — открытые вопросы участников
/export — выгрузка всех сдач в CSV (Excel)
/close <i>id</i> — закрыть задание
/cancel — отменить ввод

Сюда приходят сдачи заданий с кнопками оценки (1–5 ⭐ или ❌),
вопросы участников и ежедневный отчёт.`;

export async function handlePrivateMessage(ctx, msg) {
  const { db, tg, cfg } = ctx;
  const chatId = msg.chat.id;
  const isAdmin = cfg.adminIds.has(msg.from.id);
  const command = parseCommand(msg, cfg.botUsername);

  if (command && ["start", "help", "id"].includes(command.cmd)) {
    const idLine = `\n\n🆔 Ваш Telegram ID: <code>${msg.from.id}</code>`;
    await tg.send(chatId, isAdmin ? HELP + idLine :
      "👋 Привет! Я работаю в групповом чате: публикую задания, принимаю их сдачу " +
      "и отвечаю на вопросы. Напишите /help в группе, чтобы увидеть команды." + idLine +
      (cfg.adminIds.size ? "" : "\n\nАдминистратор ещё не назначен: впишите этот ID в переменную " +
        "<code>ADMIN_IDS</code> в настройках Cloudflare."));
    return;
  }
  if (!isAdmin) return;

  if (command) {
    const { cmd, args } = command;
    switch (cmd) {
      case "cancel":
        await db.clearState(msg.from.id);
        await tg.send(chatId, "Отменено.");
        return;
      case "stats":
        await sendLong(ctx, chatId, await fullReport(ctx));
        return;
      case "stat": {
        const task = /^\d+$/.test(args) ? await db.getTask(Number(args)) : null;
        await sendLong(ctx, chatId, task ? await taskSummary(ctx, task) : "Использование: <code>/stat 3</code>");
        return;
      }
      case "close":
        if (!/^\d+$/.test(args)) {
          await tg.send(chatId, "Использование: <code>/close 3</code>");
          return;
        }
        await tg.send(chatId, (await closeTask(ctx, Number(args))) || "Задание не найдено.");
        return;
      case "pending": {
        const subs = await db.pendingSubmissions();
        if (!subs.length) {
          await tg.send(chatId, "🎉 Все работы проверены.");
          return;
        }
        const lines = ["⏳ <b>Ожидают проверки</b>", ...subs.map((s) =>
          `• сдача #${s.id} — ${esc(s.full_name)}, задание #${s.task_id} «${esc(s.title)}» ` +
          `(${fmtDt(s.submitted_at, cfg.timezone)})`), "", "Карточки с кнопками оценки — выше в этом чате."];
        await sendLong(ctx, chatId, lines.join("\n"));
        return;
      }
      case "requests": {
        const reqs = await db.openRequests();
        if (!reqs.length) {
          await tg.send(chatId, "Открытых вопросов нет.");
          return;
        }
        const lines = ["❓ <b>Открытые вопросы</b>", ...reqs.map((r) =>
          `• #${r.id} ${esc(r.full_name)} (${fmtDt(r.created_at, cfg.timezone)}): ${esc(r.text.slice(0, 150))}`)];
        await sendLong(ctx, chatId, lines.join("\n"));
        return;
      }
      case "export": {
        const form = new FormData();
        form.append("chat_id", String(chatId));
        form.append("caption", "📎 Все сдачи заданий");
        form.append("document", new Blob([await exportCsv(ctx)], { type: "text/csv" }), "submissions.csv");
        await tg.safe("sendDocument", form);
        return;
      }
    }
    return;
  }

  // Ввод текста после кнопок «Комментарий» / «Ответить»
  const state = await db.getState(msg.from.id);
  if (!state || !msg.text) return;
  await db.clearState(msg.from.id);
  if (state.state === "comment") await saveComment(ctx, msg, state.data.subId);
  else if (state.state === "answer") await saveAnswer(ctx, msg, state.data.reqId);
}

async function saveComment(ctx, msg, subId) {
  const sub = await ctx.db.getSubmission(subId);
  if (!sub) {
    await ctx.tg.send(msg.chat.id, "Сдача не найдена.");
    return;
  }
  const task = await ctx.db.getTask(sub.task_id);
  await ctx.db.setSubmissionComment(subId, msg.text);
  await ctx.tg.send(sub.chat_id,
    `💬 Комментарий проверяющего для ${mention(sub.user_id, sub.full_name)}:\n${esc(msg.text)}`,
    { thread: task.thread_id, replyTo: sub.message_id });
  await ctx.tg.send(msg.chat.id, "✅ Комментарий отправлен в группу.");
}

async function saveAnswer(ctx, msg, reqId) {
  const req = await ctx.db.getRequest(reqId);
  if (!req) {
    await ctx.tg.send(msg.chat.id, "Запрос не найден.");
    return;
  }
  await ctx.db.answerRequest(reqId, msg.text);
  const sent = await ctx.tg.send(req.chat_id,
    `💡 ${mention(req.user_id, req.full_name)}, ответ администратора:\n${esc(msg.text)}`,
    { thread: req.thread_id, replyTo: req.message_id });
  await ctx.tg.send(msg.chat.id, sent ? "✅ Ответ отправлен в группу." : "⚠️ Не удалось отправить ответ.");
}

export async function handleAdminCallback(ctx, call) {
  const { db, tg } = ctx;
  if (!ctx.cfg.adminIds.has(call.from.id)) {
    await tg.answer(call.id, "Только для администраторов.", true);
    return;
  }
  const [kind, id, score] = call.data.split(":");

  if (kind === "rv") {
    const subId = Number(id);
    const points = Number(score);
    const sub = await db.getSubmission(subId);
    if (!sub) {
      await tg.answer(call.id, "Сдача не найдена", true);
      return;
    }
    if (!(await db.reviewSubmission(subId, points ? "approved" : "rejected", points || null, call.from.id))) {
      await tg.answer(call.id, "Эта работа уже проверена.", true);
      return;
    }
    const task = await db.getTask(sub.task_id);
    const result = points ? `✅ Принято: ${points}⭐` : "❌ Отклонено";
    const reviewer = esc([call.from.first_name, call.from.last_name].filter(Boolean).join(" "));
    const card =
      `📨 <b>Сдача #${subId}</b> — ${mention(sub.user_id, sub.full_name)}\n` +
      `Задание #${task.id}: ${esc(task.title)}\n\n<b>${result}</b> (проверил ${reviewer})`;
    // Обновляем карточку у всех админов, чтобы никто не проверил дважды
    for (const rm of await db.reviewMessages(subId)) {
      await tg.edit(rm.admin_id, rm.message_id, card, commentKeyboard(subId));
    }
    await tg.answer(call.id, result);

    const who = mention(sub.user_id, sub.full_name);
    const text = points
      ? `✅ ${who}, задание #${task.id} принято! Оценка: ${"⭐".repeat(points)} (${points}/5)`
      : `❌ ${who}, задание #${task.id} не принято. Исправьте и пришлите ещё раз (reply на задание).`;
    await tg.send(sub.chat_id, text, { thread: task.thread_id, replyTo: sub.message_id });
    return;
  }

  if (kind === "cm") {
    await db.setState(call.from.id, "comment", { subId: Number(id) });
    await tg.send(call.from.id, "💬 Напишите комментарий к работе (или /cancel):");
    await tg.answer(call.id);
    return;
  }

  if (kind === "ans") {
    const req = await db.getRequest(Number(id));
    if (!req) {
      await tg.answer(call.id, "Запрос не найден", true);
      return;
    }
    if (req.status === "answered") {
      await tg.answer(call.id, "На этот вопрос уже ответили.", true);
      return;
    }
    await db.setState(call.from.id, "answer", { reqId: req.id });
    await tg.send(call.from.id, `✍️ Напишите ответ на запрос #${req.id} (или /cancel):`);
    await tg.answer(call.id);
  }
}

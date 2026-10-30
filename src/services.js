// Общая логика: публикация заданий, приём сдач, уведомления админов.
import { requestKeyboard, reviewKeyboard, taskKeyboard } from "./keyboards.js";
import { taskSummary } from "./stats.js";
import { esc, fmtDt, fullName, mention, threadOf } from "./utils.js";

export async function notifyAdmins(ctx, text, markup = null) {
  const sent = [];
  for (const adminId of ctx.cfg.adminIds) {
    const msg = await ctx.tg.send(adminId, text, { markup });
    if (msg) sent.push([adminId, msg.message_id]);
  }
  return sent;
}

export function taskText(task, tz) {
  const parts = [`📝 <b>Задание #${task.id}: ${esc(task.title)}</b>`];
  if (task.description) parts.push("", esc(task.description));
  if (task.deadline) parts.push("", `⏰ Дедлайн: <b>${fmtDt(task.deadline, tz)}</b>`);
  parts.push("", "Чтобы сдать — <b>ответьте (reply) на это сообщение</b> текстом, фото или файлом.");
  return parts.join("\n");
}

export async function publishTask(ctx, taskId) {
  const task = await ctx.db.getTask(taskId);
  const msg = await ctx.tg.send(task.chat_id, taskText(task, ctx.cfg.timezone), {
    thread: task.thread_id,
    markup: taskKeyboard(taskId),
  });
  if (msg) {
    await ctx.db.setTaskMessage(taskId, msg.message_id);
    // без права закреплять просто не закрепится
    await ctx.tg.safe("pinChatMessage", {
      chat_id: task.chat_id, message_id: msg.message_id, disable_notification: true,
    });
  }
  return msg;
}

export async function acceptSubmission(ctx, msg, task) {
  const user = msg.from;
  if (task.closed) {
    await ctx.tg.reply(msg, "🔒 Это задание уже закрыто, сдачи не принимаются.");
    return;
  }
  const prev = await ctx.db.findSubmission(task.id, user.id);
  if (prev && prev.status === "approved") {
    await ctx.tg.reply(msg, `✅ Ваше задание #${task.id} уже принято с оценкой ${prev.score}⭐.`);
    return;
  }

  const late = Boolean(task.deadline) && Date.now() > Date.parse(task.deadline);
  const name = fullName(user);
  const { id: subId, resubmit } = await ctx.db.upsertSubmission(
    task.id, user, name, msg.chat.id, msg.message_id, late,
  );

  let reply = resubmit
    ? "🔁 Работа обновлена и отправлена на повторную проверку."
    : "📥 Работа принята на проверку!";
  if (late) reply += "\n⚠️ Сдано после дедлайна.";
  await ctx.tg.reply(msg, reply);

  const topic = await ctx.db.topicName(msg.chat.id, threadOf(msg));
  const header =
    `📨 <b>Новая сдача #${subId}</b>${resubmit ? " (повторная)" : ""}\n` +
    `Задание #${task.id}: ${esc(task.title)}\n` +
    `Тема: ${esc(topic)}\n` +
    `От: ${mention(user.id, name)}` +
    (user.username ? ` (@${esc(user.username)})` : "") +
    (late ? "\n⚠️ <b>С опозданием</b>" : "") +
    "\n\nОцените работу:";
  for (const adminId of ctx.cfg.adminIds) {
    await ctx.tg.safe("copyMessage", {
      chat_id: adminId, from_chat_id: msg.chat.id, message_id: msg.message_id,
    });
    const sent = await ctx.tg.send(adminId, header, { markup: reviewKeyboard(subId) });
    if (sent) await ctx.db.addReviewMessage(subId, adminId, sent.message_id);
  }
}

export async function registerRequest(ctx, msg, text) {
  const user = msg.from;
  const threadId = threadOf(msg);
  const reqId = await ctx.db.createRequest(
    msg.chat.id, threadId, user.id, fullName(user), text, msg.message_id,
  );
  await ctx.tg.reply(msg, `📨 Запрос #${reqId} передан администратору. Ответ придёт сюда.`);
  const topic = await ctx.db.topicName(msg.chat.id, threadId);
  await notifyAdmins(
    ctx,
    `❓ <b>Запрос #${reqId}</b> от ${mention(user.id, fullName(user))}\n` +
      `Тема: ${esc(topic)}\n\n${esc(text)}`,
    requestKeyboard(reqId),
  );
}

// Закрывает задание и возвращает итог (или null, если задания нет)
export async function closeTask(ctx, taskId) {
  const task = await ctx.db.getTask(taskId);
  if (!task) return null;
  await ctx.db.closeTask(taskId);
  const summary = await taskSummary(ctx, task);
  await ctx.tg.send(task.chat_id, `🔒 Задание #${taskId} «${esc(task.title)}» закрыто.`, {
    thread: task.thread_id,
    replyTo: task.message_id,
  });
  if (task.message_id) {
    await ctx.tg.safe("unpinChatMessage", { chat_id: task.chat_id, message_id: task.message_id });
  }
  return summary;
}

// Telegram ограничивает сообщение 4096 символами — режем по строкам
export async function sendLong(ctx, chatId, text, limit = 4000) {
  let chunk = "";
  for (const line of text.split("\n")) {
    if (chunk.length + line.length + 1 > limit) {
      await ctx.tg.send(chatId, chunk);
      chunk = "";
    }
    chunk += line + "\n";
  }
  if (chunk.trim()) await ctx.tg.send(chatId, chunk);
}

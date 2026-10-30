// Запускается Cloudflare каждую минуту: дедлайны, ежедневный отчёт, фото-исправления.
import { releaseExpired, remindUnfixed } from "./photofix.js";
import { notifyAdmins } from "./services.js";
import { fullReport, participants, taskSummary } from "./stats.js";
import { esc, fmtDt, localParts, mention } from "./utils.js";

async function missingMentions(ctx, task) {
  const submitted = new Set((await ctx.db.submissionsForTask(task.id)).map((s) => s.user_id));
  const members = await participants(ctx, task.chat_id);
  return [...members].filter(([uid]) => !submitted.has(uid)).map(([uid, name]) => mention(uid, name));
}

async function checkDeadlines(ctx) {
  const now = Date.now();
  for (const task of await ctx.db.tasksWithDeadline()) {
    const deadline = Date.parse(task.deadline);
    const opts = { thread: task.thread_id, replyTo: task.message_id };

    if (now >= deadline) {
      await ctx.db.setReminded(task.id, 2);
      const missing = await missingMentions(ctx, task);
      let text = `⏰ Дедлайн задания #${task.id} «${esc(task.title)}» наступил.`;
      text += missing.length
        ? `\nНе сдали: ${missing.join(", ")}\nПоздние сдачи принимаются с пометкой.`
        : "\n🎉 Все участники сдали работу!";
      await ctx.tg.send(task.chat_id, text, opts);
      await notifyAdmins(ctx, "⏰ Дедлайн наступил\n\n" + (await taskSummary(ctx, task)));
    } else if (task.reminded === 0 && now >= deadline - ctx.cfg.remindBeforeHours * 3_600_000) {
      await ctx.db.setReminded(task.id, 1);
      const missing = await missingMentions(ctx, task);
      if (missing.length) {
        await ctx.tg.send(task.chat_id,
          `🔔 Напоминание: задание #${task.id} «${esc(task.title)}» нужно сдать до ` +
          `${fmtDt(task.deadline, ctx.cfg.timezone)}.\nЕщё не сдали: ${missing.join(", ")}`, opts);
      }
    }
  }
}

async function checkDailyReport(ctx) {
  const local = localParts(new Date(), ctx.cfg.timezone);
  if (local.time < ctx.cfg.dailyReportTime) return;
  if ((await ctx.db.getSetting("last_daily_report")) === local.date) return;
  await ctx.db.setSetting("last_daily_report", local.date);
  if (!(await ctx.db.allTasks()).length && !(await ctx.db.donePhotoFixes()).length) return;
  let report = await fullReport(ctx);
  const pending = (await ctx.db.pendingSubmissions()).length;
  if (pending) report += `\n\n⏳ Ждут вашей проверки: ${pending} (/pending)`;
  await notifyAdmins(ctx, "🗓 <b>Ежедневный отчёт</b>\n\n" + report.slice(0, 3900));
}

export async function runScheduled(ctx) {
  for (const job of [checkDeadlines, checkDailyReport, releaseExpired, remindUnfixed]) {
    try {
      await job(ctx);
    } catch (e) {
      console.error(`Ошибка в ${job.name}:`, e);
    }
  }
}

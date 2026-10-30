// Отчёты для администратора и выгрузка в CSV.
import { esc, fmtDt } from "./utils.js";

// Участники группы без администраторов бота: Map(user_id -> имя)
export async function participants(ctx, chatId) {
  const map = new Map();
  for (const m of await ctx.db.listMembers(chatId)) {
    if (!ctx.cfg.adminIds.has(m.user_id)) map.set(m.user_id, m.full_name);
  }
  return map;
}

export async function taskSummary(ctx, task) {
  const tz = ctx.cfg.timezone;
  const subs = await ctx.db.submissionsForTask(task.id);
  const members = await participants(ctx, task.chat_id);
  const submitted = new Set(subs.map((s) => s.user_id));
  const topic = await ctx.db.topicName(task.chat_id, task.thread_id);

  const approved = subs.filter((s) => s.status === "approved");
  const pending = subs.filter((s) => s.status === "pending");
  const rejected = subs.filter((s) => s.status === "rejected");
  const missing = [...members].filter(([uid]) => !submitted.has(uid)).map(([, n]) => n);

  const lines = [
    `📌 <b>Задание #${task.id}: ${esc(task.title)}</b>`,
    `Тема: ${esc(topic)} · дедлайн: ${fmtDt(task.deadline, tz)}`,
    "",
    `Сдали: ${subs.length} из ${Math.max(members.size, subs.length)}`,
  ];
  if (approved.length) {
    const avg = approved.reduce((a, s) => a + s.score, 0) / approved.length;
    lines.push(`✅ Принято: ${approved.length} (средняя оценка ${avg.toFixed(1)})`);
    for (const s of approved) {
      lines.push(`   • ${esc(s.full_name)} — ${s.score}⭐${s.late ? " (с опозданием)" : ""}`);
    }
  }
  if (pending.length) {
    lines.push(`⏳ На проверке: ${pending.length}`);
    for (const s of pending) lines.push(`   • ${esc(s.full_name)}`);
  }
  if (rejected.length) {
    lines.push(`❌ Отклонено: ${rejected.length}`);
    for (const s of rejected) lines.push(`   • ${esc(s.full_name)}`);
  }
  if (missing.length) {
    lines.push(`🚫 Не сдали: ${missing.length}`);
    for (const n of missing) lines.push(`   • ${esc(n)}`);
  }
  return lines.join("\n");
}

export async function fullReport(ctx) {
  const tz = ctx.cfg.timezone;
  const tasks = await ctx.db.allTasks();
  const fixes = await ctx.db.donePhotoFixes();
  if (!tasks.length && !fixes.length) return "📊 Пока нет ни одного задания.";
  const subs = await ctx.db.allSubmissions();

  const approved = subs.filter((s) => s.status === "approved");
  const count = (st) => subs.filter((s) => s.status === st).length;
  const lines = [
    "📊 <b>Статистика выполнения заданий</b>",
    "",
    `Заданий: ${tasks.length} (открыто: ${tasks.filter((t) => !t.closed).length})`,
    `Сдач: ${subs.length} · ✅ ${approved.length} · ⏳ ${count("pending")} · ❌ ${count("rejected")}`,
  ];
  if (approved.length) {
    const avg = approved.reduce((a, s) => a + s.score, 0) / approved.length;
    lines.push(`Средняя оценка: ${avg.toFixed(2)}`);
  }

  // Рейтинг участников
  const tasksPerChat = new Map();
  for (const t of tasks) tasksPerChat.set(t.chat_id, (tasksPerChat.get(t.chat_id) || 0) + 1);
  const users = new Map();
  const user = (uid) => {
    if (!users.has(uid)) users.set(uid, { name: "", done: 0, points: 0, pending: 0, rejected: 0, chats: new Set() });
    return users.get(uid);
  };
  for (const chatId of tasksPerChat.keys()) {
    for (const [uid, name] of await participants(ctx, chatId)) {
      const u = user(uid);
      u.name = name;
      u.chats.add(chatId);
    }
  }
  for (const s of subs) {
    const u = user(s.user_id);
    u.name = s.full_name;
    u.chats.add(s.chat_id);
    if (s.status === "approved") { u.done++; u.points += s.score; }
    else if (s.status === "pending") u.pending++;
    else u.rejected++;
  }

  if (users.size) {
    lines.push("", "🏆 <b>Рейтинг участников</b>");
    const ranking = [...users.values()].sort((a, b) => b.points - a.points || b.done - a.done);
    ranking.forEach((u, i) => {
      const assigned = [...u.chats].reduce((a, c) => a + (tasksPerChat.get(c) || 0), 0) || tasks.length;
      const pct = assigned ? Math.round((100 * u.done) / assigned) : 0;
      const avg = u.done ? (u.points / u.done).toFixed(1) : "—";
      const extra = [u.pending ? `⏳${u.pending}` : "", u.rejected ? `❌${u.rejected}` : ""].filter(Boolean).join(" ");
      lines.push(
        `${i + 1}. ${esc(u.name)} — ${u.done}/${assigned} (${pct}%), баллы: ${u.points}, ср.: ${avg}` +
          (extra ? ` ${extra}` : ""),
      );
    });
  }

  if (fixes.length) {
    const perFixer = new Map();
    for (const f of fixes) {
      const e = perFixer.get(f.fixer_id) || { name: f.fixer_name, n: 0 };
      e.n++;
      e.name = f.fixer_name;
      perFixer.set(f.fixer_id, e);
    }
    lines.push("", `🛠 <b>Фото-исправления</b> (всего ${fixes.length})`);
    for (const e of [...perFixer.values()].sort((a, b) => b.n - a.n)) {
      lines.push(`• ${esc(e.name)} — ${e.n}`);
    }
  }

  if (tasks.length) {
    lines.push("", "📋 <b>По заданиям</b>");
    for (const t of tasks) {
      const ts = subs.filter((s) => s.task_id === t.id);
      const ok = ts.filter((s) => s.status === "approved").length;
      lines.push(
        `${t.closed ? "🔒" : "🟢"} #${t.id} ${esc(t.title)} — сдали ${ts.length}, принято ${ok}, ` +
          `дедлайн ${fmtDt(t.deadline, tz)}`,
      );
    }
  }
  return lines.join("\n");
}

export async function exportCsv(ctx) {
  const tz = ctx.cfg.timezone;
  const cell = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [[
    "submission_id", "task_id", "task", "topic", "user_id", "username", "name",
    "status", "score", "late", "comment", "submitted_at", "reviewed_at",
  ]];
  for (const s of await ctx.db.allSubmissions()) {
    rows.push([
      s.id, s.task_id, s.title, await ctx.db.topicName(s.chat_id, s.thread_id),
      s.user_id, s.username || "", s.full_name, s.status, s.score ?? "", s.late ? "да" : "",
      s.comment || "", fmtDt(s.submitted_at, tz), fmtDt(s.reviewed_at, tz),
    ]);
  }
  // BOM, чтобы Excel правильно открыл кириллицу
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}

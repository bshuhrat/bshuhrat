from __future__ import annotations

import csv
import io
from collections import defaultdict
from html import escape

from .config import Config
from .db import Database
from .utils import fmt_dt


async def participants(db: Database, cfg: Config, chat_id: int) -> dict[int, str]:
    """Участники группы (без администраторов бота): user_id -> имя."""
    return {
        m["user_id"]: m["full_name"]
        for m in await db.list_members(chat_id)
        if m["user_id"] not in cfg.admin_ids
    }


async def task_summary(db: Database, cfg: Config, task) -> str:
    subs = await db.submissions_for_task(task["id"])
    members = await participants(db, cfg, task["chat_id"])
    by_user = {s["user_id"]: s for s in subs}
    topic = await db.topic_name(task["chat_id"], task["thread_id"])

    lines = [
        f"📌 <b>Задание #{task['id']}: {escape(task['title'])}</b>",
        f"Тема: {escape(topic)} · дедлайн: {fmt_dt(task['deadline'], cfg.timezone)}",
        "",
    ]
    approved = [s for s in subs if s["status"] == "approved"]
    pending = [s for s in subs if s["status"] == "pending"]
    rejected = [s for s in subs if s["status"] == "rejected"]
    missing = [name for uid, name in members.items() if uid not in by_user]

    lines.append(f"Сдали: {len(subs)} из {max(len(members), len(subs))}")
    if approved:
        avg = sum(s["score"] for s in approved) / len(approved)
        lines.append(f"✅ Принято: {len(approved)} (средняя оценка {avg:.1f})")
        lines += [
            f"   • {escape(s['full_name'])} — {s['score']}⭐" + (" (с опозданием)" if s["late"] else "")
            for s in approved
        ]
    if pending:
        lines.append(f"⏳ На проверке: {len(pending)}")
        lines += [f"   • {escape(s['full_name'])}" for s in pending]
    if rejected:
        lines.append(f"❌ Отклонено: {len(rejected)}")
        lines += [f"   • {escape(s['full_name'])}" for s in rejected]
    if missing:
        lines.append(f"🚫 Не сдали: {len(missing)}")
        lines += [f"   • {escape(n)}" for n in missing]
    return "\n".join(lines)


async def full_report(db: Database, cfg: Config) -> str:
    tasks = await db.all_tasks()
    if not tasks and not await db.done_photo_fixes():
        return "📊 Пока нет ни одного задания."
    subs = await db.all_submissions()

    total = len(subs)
    approved = [s for s in subs if s["status"] == "approved"]
    pending = sum(1 for s in subs if s["status"] == "pending")
    rejected = sum(1 for s in subs if s["status"] == "rejected")
    open_tasks = sum(1 for t in tasks if not t["closed"])

    lines = [
        "📊 <b>Статистика выполнения заданий</b>",
        "",
        f"Заданий: {len(tasks)} (открыто: {open_tasks})",
        f"Сдач: {total} · ✅ {len(approved)} · ⏳ {pending} · ❌ {rejected}",
    ]
    if approved:
        lines.append(f"Средняя оценка: {sum(s['score'] for s in approved) / len(approved):.2f}")

    # Рейтинг участников
    per_user: dict[int, dict] = defaultdict(
        lambda: {"name": "", "done": 0, "points": 0, "pending": 0, "rejected": 0}
    )
    tasks_per_chat: dict[int, int] = defaultdict(int)
    for t in tasks:
        tasks_per_chat[t["chat_id"]] += 1
    user_chats: dict[int, set[int]] = defaultdict(set)

    for chat_id in {t["chat_id"] for t in tasks}:
        for uid, name in (await participants(db, cfg, chat_id)).items():
            per_user[uid]["name"] = name
            user_chats[uid].add(chat_id)
    for s in subs:
        u = per_user[s["user_id"]]
        u["name"] = s["full_name"]
        user_chats[s["user_id"]].add(s["chat_id"])
        if s["status"] == "approved":
            u["done"] += 1
            u["points"] += s["score"]
        elif s["status"] == "pending":
            u["pending"] += 1
        else:
            u["rejected"] += 1

    if per_user:
        lines += ["", "🏆 <b>Рейтинг участников</b>"]
        ranking = sorted(per_user.items(), key=lambda kv: (-kv[1]["points"], -kv[1]["done"]))
        for place, (uid, u) in enumerate(ranking, 1):
            assigned = sum(tasks_per_chat[c] for c in user_chats[uid]) or len(tasks)
            pct = 100 * u["done"] / assigned if assigned else 0
            avg = f"{u['points'] / u['done']:.1f}" if u["done"] else "—"
            extra = []
            if u["pending"]:
                extra.append(f"⏳{u['pending']}")
            if u["rejected"]:
                extra.append(f"❌{u['rejected']}")
            lines.append(
                f"{place}. {escape(u['name'])} — {u['done']}/{assigned} ({pct:.0f}%), "
                f"баллы: {u['points']}, ср.: {avg}" + (f" {' '.join(extra)}" if extra else "")
            )

    fixes = await db.done_photo_fixes()
    if fixes:
        per_fixer: dict[int, list] = defaultdict(list)
        for f in fixes:
            per_fixer[f["fixer_id"]].append(f["fixer_name"])
        lines += ["", f"🛠 <b>Фото-исправления</b> (всего {len(fixes)})"]
        lines += [
            f"• {escape(names[-1])} — {len(names)}"
            for names in sorted(per_fixer.values(), key=len, reverse=True)
        ]

    if tasks:
        lines += ["", "📋 <b>По заданиям</b>"]
    subs_by_task: dict[int, list] = defaultdict(list)
    for s in subs:
        subs_by_task[s["task_id"]].append(s)
    for t in tasks:
        ts = subs_by_task[t["id"]]
        ok = sum(1 for s in ts if s["status"] == "approved")
        status = "🔒" if t["closed"] else "🟢"
        lines.append(
            f"{status} #{t['id']} {escape(t['title'])} — сдали {len(ts)}, принято {ok}, "
            f"дедлайн {fmt_dt(t['deadline'], cfg.timezone)}"
        )
    return "\n".join(lines)


async def export_csv(db: Database, cfg: Config) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(
        ["submission_id", "task_id", "task", "topic", "user_id", "username", "name",
         "status", "score", "late", "comment", "submitted_at", "reviewed_at"]
    )
    for s in await db.all_submissions():
        writer.writerow([
            s["id"], s["task_id"], s["title"],
            await db.topic_name(s["chat_id"], s["thread_id"]),
            s["user_id"], s["username"] or "", s["full_name"], s["status"],
            s["score"] if s["score"] is not None else "", "да" if s["late"] else "",
            s["comment"] or "", fmt_dt(s["submitted_at"], cfg.timezone),
            fmt_dt(s["reviewed_at"], cfg.timezone),
        ])
    # BOM, чтобы Excel правильно открыл кириллицу
    return ("﻿" + buf.getvalue()).encode("utf-8")

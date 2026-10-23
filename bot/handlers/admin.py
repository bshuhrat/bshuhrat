"""Личный чат с администратором: проверка работ, ответы на запросы, статистика."""
from __future__ import annotations

from html import escape

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandObject, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import BufferedInputFile, CallbackQuery, Message

from ..config import Config
from ..db import Database
from ..keyboards import comment_keyboard
from ..services import close_task, send_to_chat
from ..stats import export_csv, full_report, task_summary
from ..utils import fmt_dt, mention

router = Router(name="admin")
router.message.filter(F.chat.type == "private")


class AdminStates(StatesGroup):
    comment = State()
    answer = State()


HELP = """👋 <b>Панель администратора</b>

/stats — общая статистика и рейтинг участников
/stat <i>id</i> — подробно по заданию
/pending — работы, ожидающие проверки
/requests — открытые вопросы участников
/export — выгрузка всех сдач в CSV (Excel)
/close <i>id</i> — закрыть задание
/cancel — отменить ввод

Сюда приходят сдачи заданий с кнопками оценки (1–5 ⭐ или ❌),
вопросы участников и ежедневный отчёт."""


@router.message(Command("start", "help"))
async def cmd_start(message: Message, cfg: Config) -> None:
    if message.from_user.id in cfg.admin_ids:
        await message.answer(HELP)
    else:
        await message.answer(
            "👋 Привет! Я работаю в групповом чате: публикую задания, принимаю их сдачу "
            "и отвечаю на вопросы. Напишите /help в группе, чтобы увидеть команды."
        )


# Все остальные команды и кнопки здесь — только для админов
admin_only = Router(name="admin_only")
router.include_router(admin_only)


def _is_admin(event: Message | CallbackQuery, cfg: Config) -> bool:
    return event.from_user.id in cfg.admin_ids


admin_only.message.filter(_is_admin)
admin_only.callback_query.filter(_is_admin)


@admin_only.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Отменено.")


@admin_only.message(Command("stats"))
async def cmd_stats(message: Message, db: Database, cfg: Config) -> None:
    await send_long(message, await full_report(db, cfg))


@admin_only.message(Command("stat"))
async def cmd_stat(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    task = await db.get_task(int(command.args)) if (command.args or "").strip().isdigit() else None
    if not task:
        await message.answer("Использование: <code>/stat 3</code>")
        return
    await send_long(message, await task_summary(db, cfg, task))


@admin_only.message(Command("close"))
async def cmd_close(
    message: Message, command: CommandObject, db: Database, cfg: Config, bot: Bot
) -> None:
    if not (command.args or "").strip().isdigit():
        await message.answer("Использование: <code>/close 3</code>")
        return
    summary = await close_task(bot, db, cfg, int(command.args))
    await message.answer(summary or "Задание не найдено.")


@admin_only.message(Command("pending"))
async def cmd_pending(message: Message, db: Database, cfg: Config) -> None:
    subs = await db.pending_submissions()
    if not subs:
        await message.answer("🎉 Все работы проверены.")
        return
    lines = ["⏳ <b>Ожидают проверки</b>"]
    lines += [
        f"• сдача #{s['id']} — {escape(s['full_name'])}, задание #{s['task_id']} "
        f"«{escape(s['title'])}» ({fmt_dt(s['submitted_at'], cfg.timezone)})"
        for s in subs
    ]
    lines.append("\nКарточки с кнопками оценки — выше в этом чате.")
    await send_long(message, "\n".join(lines))


@admin_only.message(Command("requests"))
async def cmd_requests(message: Message, db: Database, cfg: Config) -> None:
    reqs = await db.open_requests()
    if not reqs:
        await message.answer("Открытых вопросов нет.")
        return
    lines = ["❓ <b>Открытые вопросы</b>"]
    lines += [
        f"• #{r['id']} {escape(r['full_name'])} ({fmt_dt(r['created_at'], cfg.timezone)}): "
        f"{escape(r['text'][:150])}"
        for r in reqs
    ]
    await send_long(message, "\n".join(lines))


@admin_only.message(Command("export"))
async def cmd_export(message: Message, db: Database, cfg: Config) -> None:
    data = await export_csv(db, cfg)
    await message.answer_document(
        BufferedInputFile(data, filename="submissions.csv"), caption="📎 Все сдачи заданий"
    )


# ---------- оценка работ ----------

@admin_only.callback_query(F.data.startswith("rv:"))
async def cb_review(call: CallbackQuery, db: Database, cfg: Config, bot: Bot) -> None:
    _, sub_id, score = call.data.split(":")
    sub_id, score = int(sub_id), int(score)
    sub = await db.get_submission(sub_id)
    if not sub:
        await call.answer("Сдача не найдена", show_alert=True)
        return
    if sub["status"] != "pending":
        await call.answer("Эта работа уже проверена.", show_alert=True)
        return
    task = await db.get_task(sub["task_id"])

    status = "approved" if score else "rejected"
    await db.review_submission(sub_id, status, score or None, call.from_user.id)

    result = f"✅ Принято: {score}⭐" if score else "❌ Отклонено"
    reviewer = escape(call.from_user.full_name)
    card = (
        f"📨 <b>Сдача #{sub_id}</b> — {mention(sub['user_id'], sub['full_name'])}\n"
        f"Задание #{task['id']}: {escape(task['title'])}\n\n"
        f"<b>{result}</b> (проверил {reviewer})"
    )
    # Обновляем карточку у всех админов, чтобы никто не проверил дважды
    for rm in await db.review_messages(sub_id):
        try:
            await bot.edit_message_text(
                card, chat_id=rm["admin_id"], message_id=rm["message_id"],
                reply_markup=comment_keyboard(sub_id),
            )
        except TelegramAPIError:
            pass
    await call.answer(result)

    who = mention(sub["user_id"], sub["full_name"])
    if score:
        text = f"✅ {who}, задание #{task['id']} принято! Оценка: {'⭐' * score} ({score}/5)"
    else:
        text = f"❌ {who}, задание #{task['id']} не принято. Исправьте и пришлите ещё раз (reply на задание)."
    await send_to_chat(bot, sub["chat_id"], task["thread_id"], text, reply_to=sub["message_id"])


@admin_only.callback_query(F.data.startswith("cm:"))
async def cb_comment(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(AdminStates.comment)
    await state.update_data(sub_id=int(call.data.split(":")[1]))
    await call.message.answer("💬 Напишите комментарий к работе (или /cancel):")
    await call.answer()


@admin_only.message(StateFilter(AdminStates.comment), F.text)
async def on_comment(message: Message, state: FSMContext, db: Database, bot: Bot) -> None:
    sub_id = (await state.get_data())["sub_id"]
    await state.clear()
    sub = await db.get_submission(sub_id)
    if not sub:
        await message.answer("Сдача не найдена.")
        return
    task = await db.get_task(sub["task_id"])
    await db.set_submission_comment(sub_id, message.text)
    await send_to_chat(
        bot, sub["chat_id"], task["thread_id"],
        f"💬 Комментарий проверяющего для {mention(sub['user_id'], sub['full_name'])}:\n"
        f"{escape(message.text)}",
        reply_to=sub["message_id"],
    )
    await message.answer("✅ Комментарий отправлен в группу.")


# ---------- ответы на запросы участников ----------

@admin_only.callback_query(F.data.startswith("ans:"))
async def cb_answer(call: CallbackQuery, state: FSMContext, db: Database) -> None:
    req = await db.get_request(int(call.data.split(":")[1]))
    if not req:
        await call.answer("Запрос не найден", show_alert=True)
        return
    if req["status"] == "answered":
        await call.answer("На этот вопрос уже ответили.", show_alert=True)
        return
    await state.set_state(AdminStates.answer)
    await state.update_data(req_id=req["id"])
    await call.message.answer(f"✍️ Напишите ответ на запрос #{req['id']} (или /cancel):")
    await call.answer()


@admin_only.message(StateFilter(AdminStates.answer), F.text)
async def on_answer(message: Message, state: FSMContext, db: Database, bot: Bot) -> None:
    req_id = (await state.get_data())["req_id"]
    await state.clear()
    req = await db.get_request(req_id)
    if not req:
        await message.answer("Запрос не найден.")
        return
    await db.answer_request(req_id, message.text)
    sent = await send_to_chat(
        bot, req["chat_id"], req["thread_id"],
        f"💡 {mention(req['user_id'], req['full_name'])}, ответ администратора:\n"
        f"{escape(message.text)}",
        reply_to=req["message_id"],
    )
    await message.answer("✅ Ответ отправлен в группу." if sent else "⚠️ Не удалось отправить ответ.")


async def send_long(message: Message, text: str, limit: int = 4000) -> None:
    """Telegram ограничивает сообщение 4096 символами — режем по строкам."""
    chunk = ""
    for line in text.split("\n"):
        if len(chunk) + len(line) + 1 > limit:
            await message.answer(chunk)
            chunk = ""
        chunk += line + "\n"
    if chunk.strip():
        await message.answer(chunk)

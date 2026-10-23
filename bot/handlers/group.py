"""Обработчики в групповом чате: темы, автоответы, задания, сдачи, запросы."""
from __future__ import annotations

from html import escape
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware, Bot, F, Router
from aiogram.exceptions import TelegramAPIError
from aiogram.filters import Command, CommandObject
from aiogram.types import CallbackQuery, Message, TelegramObject

from ..config import Config
from ..db import Database
from ..services import accept_submission, close_task, publish_task, register_request
from ..stats import task_summary
from ..utils import (
    contains_keyword, fmt_dt, full_name, mention, parse_deadline, split_args, thread_of,
)

router = Router(name="group")
router.message.filter(F.chat.type.in_({"group", "supergroup"}))
router.callback_query.filter(F.message.chat.type.in_({"group", "supergroup"}))

SUBMIT_TAGS = ("#сдаю", "#сдал", "#сдала", "#done")

HELP_MEMBER = """🤖 <b>Команды бота</b>

<b>Для участников</b>
/tasks — открытые задания в этой теме
/info — правила и описание темы
/faq — частые вопросы темы
/ask <i>текст</i> — задать вопрос администратору
/my — моя статистика
Сдать задание — ответьте (reply) на сообщение с заданием или напишите <code>#сдаю</code> в теме с одним открытым заданием."""

HELP_ADMIN = """

<b>Для администраторов</b>
/topic <i>название</i> — назвать текущую тему
/welcome <i>текст</i> — описание/правила темы (показывается по /info)
/faq_add <i>ключевое слово | ответ</i> — автоответ в этой теме
/faq_del <i>ключевое слово</i> — удалить автоответ
/task <i>название | описание | дедлайн</i> — новое задание в этой теме
   дедлайн: <code>25.10.2026 18:00</code> или <code>25.10</code>
/close <i>id</i> — закрыть задание и получить итог
/stat <i>id</i> — итог по заданию (придёт в личку)"""


class GroupMiddleware(BaseMiddleware):
    """Ограничивает бота нужной группой и запоминает участников."""

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: Message,
        data: dict[str, Any],
    ) -> Any:
        cfg: Config = data["cfg"]
        db: Database = data["db"]
        if cfg.group_id and event.chat.id != cfg.group_id:
            return None
        user = event.from_user
        if user and not user.is_bot:
            await db.touch_member(event.chat.id, user.id, user.username, full_name(user))
        return await handler(event, data)


router.message.outer_middleware(GroupMiddleware())


def is_admin(message: Message | CallbackQuery, cfg: Config) -> bool:
    return message.from_user is not None and message.from_user.id in cfg.admin_ids


async def try_delete(message: Message) -> None:
    try:
        await message.delete()
    except TelegramAPIError:
        pass


# ---------- служебные события ----------

@router.message(F.forum_topic_created)
async def on_topic_created(message: Message, db: Database) -> None:
    await db.set_topic(message.chat.id, message.message_thread_id, message.forum_topic_created.name)


@router.message(F.forum_topic_edited.name)
async def on_topic_edited(message: Message, db: Database) -> None:
    await db.set_topic(message.chat.id, message.message_thread_id, message.forum_topic_edited.name)


@router.message(F.new_chat_members)
async def on_new_members(message: Message, db: Database) -> None:
    for user in message.new_chat_members:
        if user.is_bot:
            continue
        await db.touch_member(message.chat.id, user.id, user.username, full_name(user))
        await message.answer(
            f"👋 Добро пожаловать, {mention(user.id, full_name(user))}!\n"
            "Задания публикуются в темах группы. Команды: /help"
        )


@router.message(F.left_chat_member)
async def on_left_member(message: Message, db: Database) -> None:
    await db.remove_member(message.chat.id, message.left_chat_member.id)


# ---------- общие команды ----------

@router.message(Command("help", "start"))
async def cmd_help(message: Message, cfg: Config) -> None:
    await message.reply(HELP_MEMBER + (HELP_ADMIN if is_admin(message, cfg) else ""))


@router.message(Command("info"))
async def cmd_info(message: Message, db: Database, cfg: Config) -> None:
    thread_id = thread_of(message)
    topic = await db.get_topic(message.chat.id, thread_id)
    name = await db.topic_name(message.chat.id, thread_id)
    text = f"ℹ️ <b>{escape(name)}</b>\n\n"
    text += escape(topic["welcome"]) if topic and topic["welcome"] else "Описание темы пока не задано."
    tasks = await db.open_tasks(message.chat.id, thread_id)
    if tasks:
        text += "\n\n📝 Открытые задания:\n" + "\n".join(
            f"• #{t['id']} {escape(t['title'])} (до {fmt_dt(t['deadline'], cfg.timezone)})"
            for t in tasks
        )
    await message.reply(text)


@router.message(Command("faq"))
async def cmd_faq(message: Message, db: Database) -> None:
    items = await db.list_faq(message.chat.id, thread_of(message))
    if not items:
        await message.reply("В этой теме пока нет автоответов.")
        return
    await message.reply(
        "❓ <b>Частые вопросы</b>\n\n"
        + "\n\n".join(f"<b>{escape(i['keyword'])}</b>\n{escape(i['answer'])}" for i in items)
    )


@router.message(Command("tasks"))
async def cmd_tasks(message: Message, db: Database, cfg: Config) -> None:
    tasks = await db.open_tasks(message.chat.id, thread_of(message))
    if not tasks:
        await message.reply("В этой теме нет открытых заданий.")
        return
    lines = ["📝 <b>Открытые задания</b>"]
    for t in tasks:
        sub = await db.find_submission(t["id"], message.from_user.id)
        mark = {"approved": f"✅ {sub['score']}⭐", "pending": "⏳ на проверке",
                "rejected": "❌ нужно переделать"}.get(sub["status"], "") if sub else "— не сдано"
        lines.append(
            f"• #{t['id']} {escape(t['title'])} — до {fmt_dt(t['deadline'], cfg.timezone)} · {mark}"
        )
    await message.reply("\n".join(lines))


@router.message(Command("my"))
async def cmd_my(message: Message, db: Database) -> None:
    uid = message.from_user.id
    tasks = await db.all_tasks(message.chat.id)
    subs = [s for s in await db.all_submissions(message.chat.id) if s["user_id"] == uid]
    approved = [s for s in subs if s["status"] == "approved"]
    points = sum(s["score"] for s in approved)
    avg = f"{points / len(approved):.1f}" if approved else "—"
    await message.reply(
        f"📈 <b>Статистика: {escape(full_name(message.from_user))}</b>\n"
        f"Заданий всего: {len(tasks)}\n"
        f"✅ Принято: {len(approved)}\n"
        f"⏳ На проверке: {sum(1 for s in subs if s['status'] == 'pending')}\n"
        f"❌ Отклонено: {sum(1 for s in subs if s['status'] == 'rejected')}\n"
        f"🚫 Не сдано: {len(tasks) - len(subs)}\n"
        f"Баллы: {points} · средняя оценка: {avg}"
    )


@router.message(Command("ask", "request", "vopros"))
async def cmd_ask(
    message: Message, command: CommandObject, db: Database, cfg: Config, bot: Bot
) -> None:
    if not command.args:
        await message.reply("Напишите вопрос после команды: <code>/ask Когда дедлайн?</code>")
        return
    await register_request(message, command.args, db, cfg, bot)


# ---------- команды администратора ----------

@router.message(Command("topic"))
async def cmd_topic(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    if not is_admin(message, cfg):
        return
    if not command.args:
        await message.reply("Использование: <code>/topic Название темы</code>")
        return
    await db.set_topic(message.chat.id, thread_of(message), command.args.strip())
    await message.reply(f"✅ Тема сохранена как «{escape(command.args.strip())}».")


@router.message(Command("welcome"))
async def cmd_welcome(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    if not is_admin(message, cfg):
        return
    await db.set_welcome(message.chat.id, thread_of(message), command.args)
    await message.reply("✅ Описание темы обновлено." if command.args else "Описание темы очищено.")


@router.message(Command("faq_add"))
async def cmd_faq_add(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    if not is_admin(message, cfg):
        return
    keyword, answer = split_args(command.args, 2)
    if not keyword or not answer:
        await message.reply("Использование: <code>/faq_add дедлайн | Сдать нужно до пятницы</code>")
        return
    await db.add_faq(message.chat.id, thread_of(message), keyword, answer)
    await message.reply(f"✅ Автоответ на «{escape(keyword)}» добавлен в эту тему.")


@router.message(Command("faq_del"))
async def cmd_faq_del(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    if not is_admin(message, cfg):
        return
    ok = await db.del_faq(message.chat.id, thread_of(message), (command.args or "").strip())
    await message.reply("🗑 Удалено." if ok else "Такого автоответа нет.")


@router.message(Command("task"))
async def cmd_task(
    message: Message, command: CommandObject, db: Database, cfg: Config, bot: Bot
) -> None:
    if not is_admin(message, cfg):
        return
    title, description, deadline_raw = split_args(command.args, 3)
    if not title:
        await message.reply(
            "Использование:\n<code>/task Название | Описание | 25.10.2026 18:00</code>\n"
            "Описание и дедлайн необязательны."
        )
        return
    deadline = None
    if deadline_raw:
        dt = parse_deadline(deadline_raw, cfg.timezone)
        if dt is None:
            await message.reply("Не понял дедлайн. Формат: <code>25.10.2026 18:00</code> или <code>25.10</code>")
            return
        deadline = dt.isoformat(timespec="seconds")

    task_id = await db.create_task(message.chat.id, thread_of(message), title, description, deadline)
    if await publish_task(bot, db, cfg, task_id):
        await try_delete(message)
    else:
        await message.reply("Не удалось опубликовать задание — проверьте права бота.")


@router.message(Command("close"))
async def cmd_close(
    message: Message, command: CommandObject, db: Database, cfg: Config, bot: Bot
) -> None:
    if not is_admin(message, cfg):
        return
    if not (command.args or "").strip().isdigit():
        await message.reply("Использование: <code>/close 3</code>")
        return
    summary = await close_task(bot, db, cfg, int(command.args))
    if summary is None:
        await message.reply("Задание не найдено.")
        return
    await try_delete(message)
    try:
        await bot.send_message(message.from_user.id, summary)
    except TelegramAPIError:
        await message.answer(summary)


@router.message(Command("stat"))
async def cmd_stat(
    message: Message, command: CommandObject, db: Database, cfg: Config, bot: Bot
) -> None:
    if not is_admin(message, cfg):
        return
    task = await db.get_task(int(command.args)) if (command.args or "").strip().isdigit() else None
    if not task:
        await message.reply("Использование: <code>/stat 3</code>")
        return
    await try_delete(message)
    try:
        await bot.send_message(message.from_user.id, await task_summary(db, cfg, task))
    except TelegramAPIError:
        await message.answer("Напишите боту /start в личку, чтобы получать статистику.")


# ---------- кнопки под заданием ----------

@router.callback_query(F.data.startswith("how:"))
async def cb_how(call: CallbackQuery) -> None:
    await call.answer(
        "Нажмите «Ответить» (reply) на сообщение с заданием и пришлите текст, фото или файл. "
        "Бот передаст работу на проверку.",
        show_alert=True,
    )


@router.callback_query(F.data.startswith("who:"))
async def cb_who(call: CallbackQuery, db: Database) -> None:
    task_id = int(call.data.split(":")[1])
    subs = await db.submissions_for_task(task_id)
    if not subs:
        await call.answer("Пока никто не сдал.", show_alert=True)
        return
    icon = {"approved": "✅", "pending": "⏳", "rejected": "❌"}
    text = "\n".join(f"{icon[s['status']]} {s['full_name']}" for s in subs)
    await call.answer(text[:200], show_alert=True)


# ---------- сдачи и автоответы (должны идти последними) ----------

@router.message(F.reply_to_message)
async def on_reply(message: Message, db: Database, cfg: Config, bot: Bot) -> None:
    task = await db.task_by_message(message.chat.id, message.reply_to_message.message_id)
    if task and not is_admin(message, cfg):
        await accept_submission(message, task, db, cfg, bot)
        return
    await auto_answer(message, db, cfg, bot)


@router.message()
async def on_message(message: Message, db: Database, cfg: Config, bot: Bot) -> None:
    await auto_answer(message, db, cfg, bot)


async def auto_answer(message: Message, db: Database, cfg: Config, bot: Bot) -> None:
    text = message.text or message.caption or ""
    if not text or message.from_user is None or message.from_user.is_bot:
        return
    thread_id = thread_of(message)

    # Сдача по хэштегу, если в теме ровно одно открытое задание
    if not is_admin(message, cfg) and any(tag in text.lower() for tag in SUBMIT_TAGS):
        tasks = await db.open_tasks(message.chat.id, thread_id)
        if len(tasks) == 1:
            await accept_submission(message, tasks[0], db, cfg, bot)
        elif tasks:
            await message.reply(
                "В теме несколько заданий — ответьте (reply) на сообщение нужного задания."
            )
        else:
            await message.reply("В этой теме нет открытых заданий.")
        return

    # Автоответы по ключевым словам этой темы
    for item in await db.list_faq(message.chat.id, thread_id):
        if contains_keyword(text, item["keyword"]):
            await message.reply(escape(item["answer"]))
            return

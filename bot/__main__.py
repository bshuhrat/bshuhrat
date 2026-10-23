import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats

from .config import load_config
from .db import Database
from .handlers import admin, group
from .scheduler import run_scheduler


async def set_commands(bot: Bot) -> None:
    await bot.set_my_commands(
        [
            BotCommand(command="tasks", description="Открытые задания темы"),
            BotCommand(command="info", description="Описание темы"),
            BotCommand(command="faq", description="Частые вопросы"),
            BotCommand(command="ask", description="Вопрос администратору"),
            BotCommand(command="my", description="Моя статистика"),
            BotCommand(command="help", description="Помощь"),
        ],
        scope=BotCommandScopeAllGroupChats(),
    )
    await bot.set_my_commands(
        [
            BotCommand(command="stats", description="Общая статистика"),
            BotCommand(command="pending", description="Работы на проверке"),
            BotCommand(command="requests", description="Вопросы участников"),
            BotCommand(command="export", description="Выгрузка в CSV"),
            BotCommand(command="help", description="Помощь"),
        ],
        scope=BotCommandScopeAllPrivateChats(),
    )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    db = Database(cfg.db_path)
    await db.connect()

    bot = Bot(cfg.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(db=db, cfg=cfg)
    dp.include_routers(admin.router, group.router)

    await set_commands(bot)
    scheduler = asyncio.create_task(run_scheduler(bot, db, cfg))
    try:
        await dp.start_polling(bot)
    finally:
        scheduler.cancel()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())

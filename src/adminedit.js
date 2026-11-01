// Админ правит любой текст бота: отвечает на сообщение бота словом «исправить» и новым текстом.
// Бот заменяет свой текст (сохраняя кнопки и форматирование админа) и удаляет сообщение админа.
import { isChatAdmin } from "./photofix.js";

// «исправить <текст>», «исправить:\n<текст>», «/ispravit <текст>»
const EDIT_RE = /^\s*(?:\/ispravit(?:@\w+)?|исправить)[\s:]*/iu;

export async function handleAdminEdit(ctx, msg) {
  const target = msg.reply_to_message;
  const text = msg.text || "";
  const m = text.match(EDIT_RE);
  if (!m || !target?.from?.is_bot) return false;
  const bot = ctx.cfg.botUsername;
  if (bot && (target.from.username || "").toLowerCase() !== bot.toLowerCase()) return false;
  if (!(await isChatAdmin(ctx, msg.chat.id, msg.from.id))) return false;

  const offset = m[0].length;
  const newText = text.slice(offset);
  if (!newText.trim()) {
    await ctx.tg.reply(msg, "Напишите новый текст после слова «исправить» — бот заменит им своё сообщение.");
    return true;
  }
  // Форматирование админа (жирный, курсив, ссылки) переносим, сдвинув на длину слова «исправить»
  const entities = (msg.entities || [])
    .filter((e) => e.offset >= offset)
    .map((e) => ({ ...e, offset: e.offset - offset }));
  const params = { chat_id: msg.chat.id, message_id: target.message_id };
  if (target.reply_markup) params.reply_markup = target.reply_markup; // кнопки остаются

  const done = target.text !== undefined
    ? await ctx.tg.safe("editMessageText", { ...params, text: newText, entities })
    : await ctx.tg.safe("editMessageCaption", { ...params, caption: newText, caption_entities: entities });
  if (done) await ctx.tg.del(msg.chat.id, msg.message_id);
  else await ctx.tg.reply(msg, "Не получилось изменить это сообщение (Telegram не разрешает править его).");
  return true;
}

// Тема фото-исправлений: под каждым фото — кнопка «Отправить фото исправление».
import { photoFixKeyboard } from "./keyboards.js";
import { esc, fullName, mention, threadOf } from "./utils.js";

const CAPTION_LIMIT = 1024;

const openText = (fix) => `📷 Фото от ${mention(fix.orig_user_id, fix.orig_name)}`;

// Обрабатывает фото в теме исправлений. true — сообщение обработано
export async function handlePhoto(ctx, msg) {
  const threadId = threadOf(msg);
  if (!msg.photo || !(await ctx.db.isPhotoTopic(msg.chat.id, threadId))) return false;
  const user = msg.from;

  // Фото от участника, который взялся за исправление, — это и есть исправление
  const replyId = msg.reply_to_message ? msg.reply_to_message.message_id : null;
  const fix = await ctx.db.claimedFixFor(msg.chat.id, threadId, user.id, replyId);
  if (fix) {
    await finishFix(ctx, msg, fix);
    return true;
  }

  const fixId = await ctx.db.createPhotoFix(
    msg.chat.id, threadId, msg.message_id, msg.photo.at(-1).file_id,
    msg.caption, user.id, fullName(user),
  );
  const sent = await ctx.tg.reply(msg, openText(await ctx.db.getPhotoFix(fixId)), {
    markup: photoFixKeyboard(fixId),
  });
  if (sent) await ctx.db.setFixButton(fixId, sent.message_id);
  return true;
}

export async function onFixButton(ctx, call) {
  const fixId = Number(call.data.split(":")[1]);
  let fix = await ctx.db.getPhotoFix(fixId);
  if (!fix) {
    await ctx.tg.answer(call.id, "Фото не найдено.", true);
    return;
  }
  const name = fullName(call.from);
  if (!(await ctx.db.claimPhotoFix(fixId, call.from.id, name))) {
    fix = await ctx.db.getPhotoFix(fixId);
    const who = fix.fixer_name || "другой участник";
    await ctx.tg.answer(call.id, `Исправление уже отправляет ${who}.`, true);
    return;
  }

  // Убираем кнопку, чтобы никто другой не взялся за это фото
  await ctx.tg.edit(
    call.message.chat.id, call.message.message_id,
    `${openText(fix)}\n\n🛠 Исправление отправляет ${mention(call.from.id, name)}.\n` +
      "Пришлите исправленное фото в эту тему (можно ответом на это сообщение).",
  );
  await ctx.tg.answer(
    call.id,
    `Пришлите исправленное фото в эту тему в течение ${ctx.cfg.photoFixTimeoutMin} мин.`,
    true,
  );
}

async function finishFix(ctx, msg, fix) {
  await ctx.db.completePhotoFix(fix.id, msg.message_id);
  const fixer = fullName(msg.from);

  let origCaption = `📷 Оригинал — ${esc(fix.orig_name)}`;
  if (fix.orig_caption) origCaption += `\n${esc(fix.orig_caption)}`;
  let fixCaption = `✅ Исправление — ${esc(fixer)}`;
  if (msg.caption) fixCaption += `\n${esc(msg.caption)}`;

  // Оригинал и исправление — одним альбомом, рядом друг с другом
  const params = {
    chat_id: msg.chat.id,
    media: [
      { type: "photo", media: fix.orig_file_id, caption: origCaption.slice(0, CAPTION_LIMIT), parse_mode: "HTML" },
      { type: "photo", media: msg.photo.at(-1).file_id, caption: fixCaption.slice(0, CAPTION_LIMIT), parse_mode: "HTML" },
    ],
    reply_parameters: { message_id: fix.orig_message_id, allow_sending_without_reply: true },
  };
  if (fix.thread_id) params.message_thread_id = fix.thread_id;
  await ctx.tg.safe("sendMediaGroup", params);

  if (fix.button_message_id) {
    await ctx.tg.edit(
      msg.chat.id, fix.button_message_id,
      `${openText(fix)}\n\n✅ Исправлено: ${mention(msg.from.id, fixer)}`,
    );
  }
  await ctx.tg.reply(msg, `🙏 Спасибо за исправление, ${mention(msg.from.id, fixer)}!`);
}

// Если взявшийся не прислал фото вовремя — возвращаем кнопку всем
export async function releaseExpired(ctx) {
  const before = new Date(Date.now() - ctx.cfg.photoFixTimeoutMin * 60_000);
  const beforeIso = before.toISOString().slice(0, 19) + "Z";
  for (const fix of await ctx.db.expiredPhotoFixes(beforeIso)) {
    await ctx.db.releasePhotoFix(fix.id);
    if (!fix.button_message_id) continue;
    await ctx.tg.edit(
      fix.chat_id, fix.button_message_id,
      `${openText(fix)}\n\n⌛ ${esc(fix.fixer_name)} не прислал(а) исправление — кнопка снова доступна.`,
      photoFixKeyboard(fix.id),
    );
  }
}

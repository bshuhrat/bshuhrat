// Тема фото-исправлений: под каждым фото — кнопка «Отправить фото исправление».
import { photoFixKeyboard } from "./keyboards.js";
import { esc, fullName, localParts, mention, threadOf } from "./utils.js";

const CAPTION_LIMIT = 1024;
// Не больше напоминаний за один запуск (лимит запросов Cloudflare на бесплатном тарифе)
const REMIND_BATCH = 10;

const openText = (fix) => `📷 Фото от ${mention(fix.orig_user_id, fix.orig_name)}`;
const CALL_TO_ACTION = "\n👇 Есть ошибка? Нажмите кнопку и пришлите исправленное фото.";

const isoMinus = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19) + "Z";

// Кнопка под фото. Если Telegram не принял цветную кнопку — отправляем обычную
async function sendFixButton(ctx, chatId, threadId, replyTo, text, fixId) {
  const opts = { thread: threadId, replyTo, markup: photoFixKeyboard(fixId) };
  let sent = await ctx.tg.send(chatId, text, opts);
  if (!sent) {
    const plain = photoFixKeyboard(fixId);
    plain.inline_keyboard[0][0] = { text: plain.inline_keyboard[0][0].text, callback_data: `fix:${fixId}` };
    sent = await ctx.tg.send(chatId, text, { ...opts, markup: plain });
  }
  if (sent) await ctx.db.setFixButton(fixId, sent.message_id);
  return sent;
}

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
  const text = openText(await ctx.db.getPhotoFix(fixId)) + CALL_TO_ACTION;
  await sendFixButton(ctx, msg.chat.id, threadId, msg.message_id, text, fixId);
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
    await ctx.tg.answer(call.id, fix.status === "done"
      ? "Это фото уже исправлено."
      : `Исправление уже отправляет ${fix.fixer_name || "другой участник"}.`, true);
    return;
  }
  await ctx.tg.answer(call.id, "📸 Прикрепите исправленное фото (скрепка 📎 → камера или галерея).");

  // Убираем кнопку, чтобы никто другой не взялся за это фото
  const chatId = call.message.chat.id;
  await ctx.tg.edit(chatId, call.message.message_id,
    `${openText(fix)}\n\n🛠 Исправление отправляет ${mention(call.from.id, name)}.`);

  // Сообщение с «принудительным ответом»: у нажавшего сразу открывается ответ
  // с подсказкой — остаётся нажать скрепку и выбрать камеру или галерею.
  // (Открыть камеру напрямую Telegram ботам не позволяет.)
  const prompt = await ctx.tg.send(chatId,
    `📸 ${mention(call.from.id, name)}, пришлите исправленное фото ответом на это сообщение ` +
      `(📎 → камера или галерея). Жду ${ctx.cfg.photoFixTimeoutMin} мин.`,
    {
      thread: fix.thread_id,
      replyTo: call.message.message_id,
      markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: "Прикрепите исправленное фото 📎",
      },
    });
  if (prompt) await ctx.db.setFixPrompt(fixId, prompt.message_id);
}

async function finishFix(ctx, msg, fix) {
  await ctx.db.completePhotoFix(fix.id, msg.message_id);
  const chatId = msg.chat.id;
  const fixer = fullName(msg.from);
  const thanks = `🙏 Спасибо за исправление, ${mention(msg.from.id, fixer)}!`;

  // Одна подпись на весь альбом: кто прислал нарушение, кто исправил (выделен), спасибо
  let caption = `📷 <b>Нарушение</b> — ${mention(fix.orig_user_id, fix.orig_name)}`;
  if (fix.orig_caption) caption += `\n${esc(fix.orig_caption.slice(0, 300))}`;
  caption += `\n\n✅ <b>Исправил(а): ${mention(msg.from.id, fixer)}</b>`;
  if (msg.caption) caption += `\n${esc(msg.caption.slice(0, 300))}`;
  caption += `\n\n${thanks}`;

  const params = {
    chat_id: chatId,
    media: [
      { type: "photo", media: fix.orig_file_id, caption: caption.slice(0, CAPTION_LIMIT), parse_mode: "HTML" },
      { type: "photo", media: msg.photo.at(-1).file_id },
    ],
  };
  if (fix.thread_id) params.message_thread_id = fix.thread_id;

  if (await ctx.tg.safe("sendMediaGroup", params)) {
    // Альбом опубликован — убираем из чата исходные фото и служебные сообщения бота,
    // чтобы фотографии не дублировались
    for (const id of [fix.orig_message_id, msg.message_id, fix.button_message_id, fix.prompt_message_id]) {
      if (id) await ctx.tg.del(chatId, id);
    }
    return;
  }

  // Альбом отправить не удалось — оставляем фото в чате и просто отмечаем исправление
  if (fix.button_message_id) {
    await ctx.tg.edit(chatId, fix.button_message_id,
      `${openText(fix)}\n\n✅ Исправлено: <b>${mention(msg.from.id, fixer)}</b>`);
  }
  if (fix.prompt_message_id) await ctx.tg.del(chatId, fix.prompt_message_id);
  await ctx.tg.reply(msg, thanks);
}

// Если взявшийся не прислал фото вовремя — возвращаем кнопку всем
export async function releaseExpired(ctx) {
  for (const fix of await ctx.db.expiredPhotoFixes(isoMinus(ctx.cfg.photoFixTimeoutMin * 60_000))) {
    await ctx.db.releasePhotoFix(fix.id);
    if (fix.prompt_message_id) await ctx.tg.del(fix.chat_id, fix.prompt_message_id);
    if (!fix.button_message_id) continue;
    await ctx.tg.edit(
      fix.chat_id, fix.button_message_id,
      `${openText(fix)}\n\n⌛ ${esc(fix.fixer_name)} не прислал(а) исправление — кнопка снова доступна.`,
      photoFixKeyboard(fix.id),
    );
  }
}

// Через N часов напоминаем о фото без исправления — только в дневное время
export async function remindUnfixed(ctx) {
  const { photoRemindHours, photoRemindFrom, photoRemindTo, timezone } = ctx.cfg;
  const now = localParts(new Date(), timezone).time;
  if (now < photoRemindFrom || now > photoRemindTo) return;

  for (const fix of await ctx.db.unfixedPhotos(isoMinus(photoRemindHours * 3_600_000), REMIND_BATCH)) {
    await ctx.db.markFixReminded(fix.id);
    // Старую кнопку убираем, новую ставим под напоминанием — чтобы была на виду
    if (fix.button_message_id && !(await ctx.tg.del(fix.chat_id, fix.button_message_id))) {
      await ctx.tg.edit(fix.chat_id, fix.button_message_id, openText(fix));
    }
    await sendFixButton(ctx, fix.chat_id, fix.thread_id, fix.orig_message_id,
      `⏰ <b>Нужно исправить!</b>\n${openText(fix)} ждёт исправления уже больше ` +
        `${photoRemindHours} ч.${CALL_TO_ACTION}`,
      fix.id);
  }
}

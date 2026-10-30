// Тема фото-исправлений: под каждым фото — кнопка «Отправить фото исправление».
import { FIXED_PNG, VIOLATION_PNG } from "./banners.js";
import { photoFixKeyboard, returnKeyboard } from "./keyboards.js";
import { esc, fullName, localParts, mention, threadOf } from "./utils.js";

const CAPTION_LIMIT = 1024;
// Не больше напоминаний за один запуск (лимит запросов Cloudflare на бесплатном тарифе)
const REMIND_BATCH = 10;

const openText = (fix) => `📷 Фото от ${mention(fix.orig_user_id, fix.orig_name)}`;
const CALL_TO_ACTION = "\n👇 Есть ошибка? Нажмите кнопку и пришлите исправленное фото.";

const isoMinus = (ms) => new Date(Date.now() - ms).toISOString().slice(0, 19) + "Z";

// Та же клавиатура без цвета — для старых версий Telegram, не принимающих style
function plainKeyboard(markup) {
  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map(({ text, callback_data }) => ({ text, callback_data }))),
  };
}

// Отправка с цветной кнопкой; если Telegram её не принял — с обычной
async function withButtonFallback(send, markup) {
  return (await send(markup)) || send(plainKeyboard(markup));
}

// Кнопка под фото
async function sendFixButton(ctx, chatId, threadId, replyTo, text, fixId) {
  const sent = await withButtonFallback(
    (markup) => ctx.tg.send(chatId, text, { thread: threadId, replyTo, markup }),
    photoFixKeyboard(fixId));
  if (sent) await ctx.db.setFixButton(fixId, sent.message_id);
  return sent;
}

// После «Вернуть в работу» кнопка стоит прямо на фото — тогда меняем подпись, а не текст
function editFixMessage(ctx, fix, text, markup = null) {
  if (fix.button_message_id === fix.orig_message_id) {
    return ctx.tg.editCaption(fix.chat_id, fix.button_message_id, text, markup);
  }
  return ctx.tg.edit(fix.chat_id, fix.button_message_id, text, markup);
}

// Тема фото-исправлений: из переменной PHOTO_TOPIC (ссылка на тему) или включённая /photo_topic
export async function isPhotoTopic(ctx, chatId, threadId) {
  const topic = ctx.cfg.photoTopic;
  if (topic) return topic.chatId === chatId && topic.threadId === threadId;
  return ctx.db.isPhotoTopic(chatId, threadId);
}

// Обрабатывает фото в теме исправлений. true — сообщение обработано
export async function handlePhoto(ctx, msg) {
  const threadId = threadOf(msg);
  if (!msg.photo || !(await isPhotoTopic(ctx, msg.chat.id, threadId))) return false;
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
  await editFixMessage(ctx, { ...fix, button_message_id: call.message.message_id },
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

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const streamOf = (bytes) => new Blob([bytes]).stream();

// Рисует полосу (НАРУШЕНИЕ / ИСПРАВЛЕНО) поверх верхней части фото через Cloudflare Images
async function stamp(images, photo, bannerB64) {
  const { width } = await images.info(streamOf(photo));
  const banner = images.input(streamOf(fromBase64(bannerB64))).transform({ width });
  const result = await images.input(streamOf(photo))
    .draw(banner, { top: 0, left: 0 })
    .output({ format: "image/jpeg" });
  return new Blob([await result.response().arrayBuffer()], { type: "image/jpeg" });
}

// Альбом из двух фото с отметками; без Cloudflare Images (или при ошибке) — без отметок
async function sendFixAlbum(ctx, chatId, threadId, origFileId, fixFileId, caption) {
  const media = [
    { type: "photo", media: origFileId, caption, parse_mode: "HTML" },
    { type: "photo", media: fixFileId },
  ];
  if (ctx.images) {
    try {
      const [violation, fixed] = await Promise.all([
        ctx.tg.download(origFileId).then((p) => stamp(ctx.images, p, VIOLATION_PNG)),
        ctx.tg.download(fixFileId).then((p) => stamp(ctx.images, p, FIXED_PNG)),
      ]);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (threadId) form.append("message_thread_id", String(threadId));
      form.append("media", JSON.stringify([
        { ...media[0], media: "attach://violation" },
        { ...media[1], media: "attach://fixed" },
      ]));
      form.append("violation", violation, "violation.jpg");
      form.append("fixed", fixed, "fixed.jpg");
      return await ctx.tg.call("sendMediaGroup", form);
    } catch (e) {
      console.warn("Не удалось отметить фото, отправляю без отметок:", String(e));
    }
  }
  const params = { chat_id: chatId, media };
  if (threadId) params.message_thread_id = threadId;
  return ctx.tg.safe("sendMediaGroup", params);
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

  const album = await sendFixAlbum(ctx, chatId, fix.thread_id, fix.orig_file_id,
    msg.photo.at(-1).file_id, caption.slice(0, CAPTION_LIMIT));
  if (album) {
    // Альбом опубликован — убираем из чата исходные фото и служебные сообщения бота,
    // чтобы фотографии не дублировались
    const ids = [fix.orig_message_id, msg.message_id, fix.button_message_id, fix.prompt_message_id];
    for (const id of new Set(ids.filter(Boolean))) await ctx.tg.del(chatId, id);

    // Кнопку «Вернуть в работу» видят только администраторы — она приходит им в личку
    const albumIds = album.map((m) => m.message_id);
    const adminMessages = await notifyAdminsOfFix(ctx, fix, msg.from, albumIds[0]);
    await ctx.db.setFixResult(fix.id, albumIds, adminMessages);
    return;
  }

  // Альбом отправить не удалось — оставляем фото в чате и просто отмечаем исправление
  if (fix.button_message_id) {
    await editFixMessage(ctx, fix, `${openText(fix)}\n\n✅ Исправлено: <b>${mention(msg.from.id, fixer)}</b>`);
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
    await withButtonFallback((markup) => editFixMessage(ctx, fix,
      `${openText(fix)}\n\n⌛ ${esc(fix.fixer_name)} не прислал(а) исправление — кнопка снова доступна.`,
      markup), photoFixKeyboard(fix.id));
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
    if (fix.button_message_id === fix.orig_message_id) {
      await editFixMessage(ctx, fix, openText(fix)); // само фото не удаляем — только кнопку
    } else if (fix.button_message_id && !(await ctx.tg.del(fix.chat_id, fix.button_message_id))) {
      await editFixMessage(ctx, fix, openText(fix));
    }
    await sendFixButton(ctx, fix.chat_id, fix.thread_id, fix.orig_message_id,
      `⏰ <b>Нужно исправить!</b>\n${openText(fix)} ждёт исправления уже больше ` +
        `${photoRemindHours} ч.${CALL_TO_ACTION}`,
      fix.id);
  }
}

// Ссылка на сообщение в теме супергруппы
function messageLink(chatId, threadId, messageId) {
  const chat = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${chat}/${threadId ? `${threadId}/` : ""}${messageId}`;
}

// Все, кто может вернуть фото в работу: ADMIN_IDS и администраторы группы (без ботов)
async function adminRecipients(ctx, chatId) {
  const ids = new Set(ctx.cfg.adminIds);
  const admins = await ctx.tg.safe("getChatAdministrators", { chat_id: chatId });
  for (const a of admins || []) if (!a.user.is_bot) ids.add(a.user.id);
  return [...ids];
}

// Сообщает администраторам в личку об исправлении — с кнопкой «Вернуть в работу».
// Дойдёт до тех, кто хотя бы раз нажал /start у бота.
async function notifyAdminsOfFix(ctx, fix, fixer, albumMessageId) {
  const text =
    `✅ <b>Фото исправлено</b>\n` +
    `Нарушение — ${mention(fix.orig_user_id, fix.orig_name)}\n` +
    `Исправил(а) — ${mention(fixer.id, fullName(fixer))}\n` +
    `<a href="${messageLink(fix.chat_id, fix.thread_id, albumMessageId)}">Посмотреть в теме</a>\n\n` +
    "Не согласны с исправлением? Верните фото в работу:";
  const sent = [];
  for (const adminId of await adminRecipients(ctx, fix.chat_id)) {
    const msg = await withButtonFallback(
      (markup) => ctx.tg.send(adminId, text, { markup }), returnKeyboard(fix.id));
    if (msg) sent.push([adminId, msg.message_id]);
  }
  return sent;
}

// Админ может вернуть фото в работу, если не согласен с исправлением
async function isChatAdmin(ctx, chatId, userId) {
  if (ctx.cfg.adminIds.has(userId)) return true;
  const member = await ctx.tg.safe("getChatMember", { chat_id: chatId, user_id: userId });
  return Boolean(member && ["creator", "administrator"].includes(member.status));
}

export async function onReturnButton(ctx, call) {
  const fixId = Number(call.data.split(":")[1]);
  const fix = await ctx.db.getPhotoFix(fixId);
  if (!fix) {
    await ctx.tg.answer(call.id, "Фото не найдено.", true);
    return;
  }
  const chatId = fix.chat_id;
  if (!(await isChatAdmin(ctx, chatId, call.from.id))) {
    await ctx.tg.answer(call.id, "Вернуть в работу может только администратор.", true);
    return;
  }
  if (!(await ctx.db.reopenPhotoFix(fixId))) {
    await ctx.tg.answer(call.id, "Это фото уже возвращено в работу.", true);
    return;
  }
  await ctx.tg.answer(call.id, "↩️ Фото возвращено в работу.");

  // Убираем альбом с исправлением (и строку с кнопкой из прошлой версии бота, если была)
  const ids = [...JSON.parse(fix.result_message_ids || "[]"), fix.control_message_id];
  for (const id of new Set(ids.filter(Boolean))) await ctx.tg.del(chatId, id);

  // У всех админов в личке кнопку заменяем отметкой, кто вернул
  const who = mention(call.from.id, fullName(call.from));
  const adminMessages = JSON.parse(fix.admin_messages || "[]");
  if (call.message.chat.type === "private") adminMessages.push([call.message.chat.id, call.message.message_id]);
  const seen = new Set();
  for (const [adminChat, messageId] of adminMessages) {
    if (seen.has(`${adminChat}:${messageId}`)) continue;
    seen.add(`${adminChat}:${messageId}`);
    await ctx.tg.edit(adminChat, messageId,
      `↩️ Фото от ${mention(fix.orig_user_id, fix.orig_name)} возвращено в работу (${who}).\n` +
      `Исправление от ${mention(fix.fixer_id, fix.fixer_name)} не принято.`);
  }

  // Публикуем исходное фото-нарушение заново — с красной кнопкой прямо на нём
  let caption = openText(fix);
  if (fix.orig_caption) caption += `\n${esc(fix.orig_caption.slice(0, 300))}`;
  caption += `\n\n↩️ <b>Возвращено в работу</b> администратором ${mention(call.from.id, fullName(call.from))}: ` +
    `исправление от ${mention(fix.fixer_id, fix.fixer_name)} не принято.${CALL_TO_ACTION}`;
  const params = { chat_id: chatId, photo: fix.orig_file_id, caption: caption.slice(0, CAPTION_LIMIT), parse_mode: "HTML" };
  if (fix.thread_id) params.message_thread_id = fix.thread_id;
  const sent = await withButtonFallback(
    (reply_markup) => ctx.tg.safe("sendPhoto", { ...params, reply_markup }),
    photoFixKeyboard(fixId));
  if (sent) await ctx.db.setFixPhotoMessage(fixId, sent.message_id);
}

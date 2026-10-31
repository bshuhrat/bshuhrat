// Разбор отчётов по фото: ИИ (Kimi в Cloudflare Workers AI, бесплатный дневной лимит) читает
// показатели и пишет, где молодцы и что улучшить. Работа идёт в фоне через планировщик,
// потому что ответ ИИ может занимать дольше, чем Telegram ждёт ответа на вебхук.
import { esc, fullName, mention, parseCommand, threadOf } from "./utils.js";

export const DEFAULT_AI_MODEL = "@cf/moonshotai/kimi-k2.6";
// Если основная модель не ответила — пробуем запасные (тоже бесплатные, с поддержкой картинок)
const FALLBACK_MODELS = ["@cf/moonshotai/kimi-k2.5", "@cf/meta/llama-4-scout-17b-16e-instruct"];
const MODEL_NAMES = {
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.5": "Kimi K2.5",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
};
const modelName = (m) => MODEL_NAMES[m] || m.split("/").pop();
const JOBS_PER_RUN = 2;
const MAX_ATTEMPTS = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TRIGGER_RE = /^\s*(?:\/(?:razbor|report)(?:@\w+)?|разбор|разбери)\s*$/iu;

const SYSTEM_PROMPT = `Ты — опытный управляющий сетью пиццерий. Тебе присылают фото или скриншот отчёта с показателями.
Разбери его и ответь строго по-русски, коротко, обычным текстом с эмодзи. Не используй Markdown: никаких *, #, таблиц.

Формат ответа:
📊 Что в отчёте: одна строка — какой это отчёт и за какой период (если видно).

✅ Молодцы:
— показатель: значение — почему это хорошо

⚠️ Улучшить:
— показатель: значение (норма …) — в чём проблема

🎯 Что сделать:
1. … (2–4 конкретных шага, самые важные первыми)

Правила:
— Бери только цифры, которые реально видны на изображении. Ничего не выдумывай.
— Если часть цифр не читается — так и напиши.
— Сравнивай с нормами, если они даны. Если норм нет — оценивай по типичным показателям пиццерий и пометь это словами «(обычно в пиццериях …)».
— Если на изображении не отчёт с показателями — ответь одной строкой: «На фото нет отчёта с показателями».`;

export function isReportTopic(ctx, chatId, threadId) {
  const t = ctx.cfg.reportTopic;
  return Boolean(t) && t.chatId === chatId && t.threadId === threadId;
}

// Картинка в сообщении: фото или файл-изображение
function imageOf(msg) {
  if (msg?.photo?.length) {
    const p = msg.photo.at(-1);
    return { fileId: p.file_id, size: p.file_size || 0 };
  }
  if (msg?.document && /^image\//.test(msg.document.mime_type || "")) {
    return { fileId: msg.document.file_id, size: msg.document.file_size || 0 };
  }
  return null;
}

const normsKey = (chatId) => `report_norms:${chatId}`;

// true — сообщение обработано (поставлено в очередь на разбор или это команда норм)
export async function handleReportMessage(ctx, msg) {
  const chatId = msg.chat.id;
  const command = parseCommand(msg, ctx.cfg.botUsername);

  // Нормы для разбора: /normy — показать, /normy_set … — задать (админ)
  if (command?.cmd === "normy") {
    const norms = await ctx.db.getSetting(normsKey(chatId));
    await ctx.tg.reply(msg, norms
      ? `📏 <b>Нормы для разбора отчётов</b>\n${esc(norms)}`
      : "Нормы ещё не заданы — ИИ сравнивает с типичными показателями пиццерий.\n" +
        "Админ может задать: <code>/normy_set доставка до 30 мин; списания до 2%; средний чек от 1100 ₽</code>");
    return true;
  }
  if (command?.cmd === "normy_set") {
    if (!ctx.cfg.adminIds.has(msg.from.id)) return true;
    await ctx.db.setSetting(normsKey(chatId), command.args);
    await ctx.tg.reply(msg, command.args ? "✅ Нормы сохранены." : "Нормы очищены.");
    return true;
  }

  // «разбор» в ответ на фото — в любой теме; в теме отчётов — любое фото
  let source = null;
  if (msg.reply_to_message && TRIGGER_RE.test(msg.text || "")) {
    source = msg.reply_to_message;
    if (!imageOf(source)) {
      await ctx.tg.reply(msg, "Ответьте словом «разбор» на фото или скриншот отчёта.");
      return true;
    }
  } else if (imageOf(msg) && isReportTopic(ctx, chatId, threadOf(msg))) {
    source = msg;
  }
  if (!source) return false;

  const image = imageOf(source);
  if (image.size > MAX_IMAGE_BYTES) {
    await ctx.tg.reply(msg, "Картинка слишком большая — пришлите скриншот поменьше.");
    return true;
  }
  if (!ctx.ai) {
    await ctx.tg.reply(msg, "ИИ для разбора отчётов не подключён (нет привязки AI в Cloudflare).");
    return true;
  }
  const placeholder = await ctx.tg.send(chatId, "⏳ Разбираю отчёт… Обычно это занимает 1–2 минуты.", {
    thread: threadOf(msg), replyTo: source.message_id,
  });
  if (!placeholder) return true;
  await ctx.db.createReportJob({
    chatId, threadId: threadOf(msg), sourceMessageId: source.message_id, fileId: image.fileId,
    caption: source.caption || "", requestedBy: fullName(msg.from), requestedById: msg.from.id,
    placeholderId: placeholder.message_id,
  });
  return true;
}

// ---------- работа ИИ (из планировщика) ----------

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Текст ответа модели: Workers AI отдаёт либо { response }, либо формат OpenAI { choices }
export function aiText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return "";
}

// Убираем рассуждения модели и Markdown, если она всё же его вставила
function cleanup(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (t.includes("</think>")) t = t.slice(t.lastIndexOf("</think>") + 8);
  return t.replace(/\*\*|__|^#+\s*/gm, "").trim();
}

async function analyze(ctx, job) {
  const bytes = await ctx.tg.download(job.file_id);
  const mime = bytes[0] === 0x89 ? "image/png" : "image/jpeg";
  const norms = await ctx.db.getSetting(normsKey(job.chat_id));
  let prompt = "Разбери этот отчёт.";
  if (norms) prompt += `\nНормы: ${norms}`;
  if (job.caption) prompt += `\nКомментарий к фото: ${job.caption}`;

  const input = {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(bytes)}` } },
        ],
      },
    ],
    max_tokens: 4096, // с запасом: Kimi может сначала рассуждать
  };

  // Пробуем модели по очереди; ошибки собираем, чтобы показать причину
  const errors = [];
  for (const model of [...new Set([ctx.cfg.aiModel, ...FALLBACK_MODELS])]) {
    try {
      const text = cleanup(aiText(await ctx.ai.run(model, input)));
      if (text) return { text, model };
      errors.push(`${modelName(model)}: пустой ответ`);
    } catch (e) {
      errors.push(`${modelName(model)}: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  throw new Error(errors.join("; "));
}

export async function processReportJobs(ctx) {
  if (!ctx.ai) return;
  for (const job of await ctx.db.pendingReportJobs(JOBS_PER_RUN)) {
    // Помечаем заранее: если обработка упадёт посреди, задача не зациклится
    await ctx.db.bumpReportJob(job.id);
    try {
      const { text, model } = await analyze(ctx, job);
      const header = `🤖 <b>Разбор отчёта</b> (запросил(а) ${mention(job.requested_by_id, job.requested_by)}, ` +
        `${esc(modelName(model))})\n\n`;
      await ctx.tg.edit(job.chat_id, job.placeholder_id, (header + esc(text)).slice(0, 4000));
      await ctx.db.finishReportJob(job.id, "done");
    } catch (e) {
      console.error("Разбор отчёта не удался:", e);
      if (job.attempts + 1 >= MAX_ATTEMPTS) {
        await ctx.db.finishReportJob(job.id, "failed");
        const limit = /limit|quota|neuron|4006|429/i.test(String(e));
        const reason = `\n\n<i>Причина: ${esc(String(e?.message || e).slice(0, 600))}</i>`;
        await ctx.tg.edit(job.chat_id, job.placeholder_id, (limit
          ? "❌ Бесплатный дневной лимит ИИ закончился. Попробуйте завтра — ответьте на фото словом «разбор»."
          : "❌ Не получилось разобрать отчёт. Попробуйте ещё раз: ответьте на фото словом «разбор».") + reason);
      }
    }
  }
}

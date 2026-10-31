// Разбор отчётов по фото: ИИ (Kimi в Cloudflare Workers AI, бесплатный дневной лимит) читает
// показатели и пишет, где молодцы и что улучшить. Работа идёт в фоне через планировщик,
// потому что ответ ИИ может занимать дольше, чем Telegram ждёт ответа на вебхук.
import { esc, fullName, mention, parseCommand, threadOf } from "./utils.js";

export const DEFAULT_AI_MODEL = "@cf/moonshotai/kimi-k2.6";
// Другие бесплатные модели Workers AI с поддержкой картинок — участвуют в выборе лучшего ответа
const FALLBACK_MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct"];
const MODEL_NAMES = {
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.5": "Kimi K2.5",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
};
const modelName = (m) => MODEL_NAMES[m] || m.split("/").pop();
const JOBS_PER_RUN = 2;
const MAX_ATTEMPTS = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// «разбор», «разбор Москва 8», «/razbor Москва 3»
const TRIGGER_RE = /^\s*(?:\/(?:razbor|report)(?:@\w+)?|разбор|разбери)(?:\s+(.+?))?\s*$/iu;

const SYSTEM_PROMPT = `Ты — операционный директор Додо Пиццы. Тебе прислали операционный отчёт (таблицу) сети пиццерий. Твоя задача — коротко объяснить менеджеру одной пиццерии, что у него не так, почему, и что ему сделать.

Как читать таблицу:
— Строки — пиццерии («Москва - 8» и т.п.). Если у точки есть строка «Итог» и строки по ресторанам — бери «Итог».
— Последняя строка «Сеть» — показатели всей сети. Сравнивай с ней только средние и доли (производительность, проценты, время, рейтинг). Выручку и количества с «Сетью» НЕ сравнивай: там сумма по всем точкам.
— Бери только числа, которые видишь. Не выдумывай.

Как искать причины (связывай показатели между собой):
— Низкая производительность кухни (продуктов на человека в час) при нормальной выручке → на смене больше людей, чем нужно.
— Низкая производительность курьеров (заказов в час) + много поездок с одним заказом → курьеров больше, чем заказов, возят по одному.
— Долгая доставка, много доставок дольше 40 минут, сертификаты за опоздание, при том что курьеров много → заказы ждут кухню или курьеров отправляют поздно/по одному.
— Долгое приготовление, заказы в ресторане дольше 13 минут → кухня не успевает: неправильная расстановка по станциям или мало заготовок.
— Время в стопе и упущенная выручка → закончились ингредиенты или заготовки: остатки и заказ поставки проверяют плохо.

Как писать:
— Очень коротко. Без вступлений и общих слов.
— ЗАПРЕЩЕНЫ слова: «проанализировать», «оптимизировать», «улучшить», «внедрить», «рассмотреть», «повысить эффективность», «переобучить персонал». Вместо них — конкретное действие менеджера.
— Действия — только то, что менеджер делает сам: график и число людей на смене, расстановка по станциям, отправка курьеров (по 2 заказа в один район), заготовки и остатки до пика, заказ поставки, стоп-лист, пятиминутка с командой.
— У действия — когда: «сегодня», «на ближайшей смене», «до конца недели».
— Максимум 3 проблемы, самые важные. Пиши обычным текстом с эмодзи, без Markdown (никаких *, #, таблиц).

Формат (строго):
📍 <точка>
Главное: <1–2 предложения: что случилось и почему, связав показатели>

✅ Хорошо: <1–2 показателя через запятую, со значением и сетью>

❗ Что исправить:
1) <показатель> <значение> (сеть <значение>) — <почему, одной фразой>
👉 <действие> (<когда>); <действие> (<когда>)

Пример хорошего ответа (числа выдуманы, бери свои из отчёта):
📍 Москва - 5
Главное: людей на смене много, а работают медленно: кухня делает 6,1 продукта в час на человека (сеть 8,0), курьеры возят по одному заказу — поэтому доставка долгая и растут сертификаты за опоздание.

✅ Хорошо: рейтинг 4,9 (сеть 4,8), почти нет стопов 0,1% (сеть 0,5%)

❗ Что исправить:
1) Производительность кухни 6,1 (сеть 8,0) — на смене лишние люди в непиковые часы
👉 Убери 1 повара с 11:00–16:00 в графике на следующую неделю (до конца недели)
2) Доставка 38 мин (сеть 33), сертификаты 8,8% (сеть 6,5%) — курьеры уезжают с 1 заказом и ждут на точке
👉 Отправляй курьера с 2 заказами в один район, если второй готов за 3 минуты (на ближайшей смене); поставь 1 курьера меньше в 14:00–17:00 (до конца недели)
3) Упущенная выручка 3 610 ₽ из-за стопов — закончились заготовки в пик
👉 Перед 17:00 проверь остатки и сделай заготовки на вечер (сегодня); заказывай поставку по остаткам, а не «на глаз» (до конца недели)

Если нужной точки в отчёте нет — напиши это и перечисли видимые точки. Если на фото не отчёт — ответь: «На фото нет отчёта с показателями».`;

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
const locationKey = (chatId) => `report_location:${chatId}`;

// Точка для разбора по умолчанию: заданная в чате командой /tochka_set или REPORT_LOCATION
async function defaultLocation(ctx, chatId) {
  return (await ctx.db.getSetting(locationKey(chatId))) || ctx.cfg.reportLocation || "";
}

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

  // Точка по умолчанию: /tochka — показать, /tochka_set Москва 8 — задать (админ)
  if (command?.cmd === "tochka") {
    const loc = await defaultLocation(ctx, chatId);
    await ctx.tg.reply(msg, loc
      ? `📍 Отчёты разбираются по точке: <b>${esc(loc)}</b>\nДругую точку можно указать в запросе: <code>разбор Москва 3</code>`
      : "Точка по умолчанию не задана — разбирается вся сеть.\nАдмин может задать: <code>/tochka_set Москва 8</code>");
    return true;
  }
  if (command?.cmd === "tochka_set") {
    if (!ctx.cfg.adminIds.has(msg.from.id)) return true;
    await ctx.db.setSetting(locationKey(chatId), command.args);
    await ctx.tg.reply(msg, command.args ? `✅ Теперь отчёты разбираются по точке «${esc(command.args)}».` : "Точка по умолчанию очищена.");
    return true;
  }

  // «разбор» в ответ на фото — в любой теме; в теме отчётов — любое фото
  let source = null;
  let location = "";
  const trigger = (msg.text || "").match(TRIGGER_RE);
  if (msg.reply_to_message && trigger) {
    source = msg.reply_to_message;
    location = (trigger[1] || "").trim();
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
  if (!ctx.ai && !ctx.cfg.geminiKey) {
    await ctx.tg.reply(msg, "ИИ для разбора отчётов не подключён (нет привязки AI в Cloudflare и ключа Gemini).");
    return true;
  }
  const placeholder = await ctx.tg.send(chatId, "⏳ Разбираю отчёт… Обычно это занимает 1–2 минуты.", {
    thread: threadOf(msg), replyTo: source.message_id,
  });
  if (!placeholder) return true;
  await ctx.db.createReportJob({
    chatId, threadId: threadOf(msg), sourceMessageId: source.message_id, fileId: image.fileId,
    caption: source.caption || "", requestedBy: fullName(msg.from), requestedById: msg.from.id,
    placeholderId: placeholder.message_id, location: location || await defaultLocation(ctx, chatId),
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

// ---------- модели ----------

// Один «участник»: { name, run(prompt, system, image) -> текст }
function workersModel(ctx, model) {
  return {
    name: modelName(model),
    async run(system, prompt, image, maxTokens = 4096) {
      const result = await ctx.ai.run(model, {
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.b64}` } },
            ],
          },
        ],
        max_tokens: maxTokens, // с запасом: модели могут сначала рассуждать
      });
      return cleanup(aiText(result));
    },
  };
}

// Google Gemini (бесплатный тариф, ключ GEMINI_API_KEY из Google AI Studio)
function geminiModel(ctx) {
  const model = ctx.cfg.geminiModel;
  return {
    name: "Gemini",
    async run(system, prompt, image, maxTokens = 8192) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": ctx.cfg.geminiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: image.mime, data: image.b64 } }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${data?.error?.message || ""}`);
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return cleanup(parts.filter((p) => !p.thought).map((p) => p.text || "").join(""));
    },
  };
}

// Участники соревнования: Gemini (если есть ключ) и модели Workers AI
function contestants(ctx) {
  const list = [];
  if (ctx.cfg.geminiKey) list.push(geminiModel(ctx));
  if (ctx.ai) {
    for (const m of [...new Set([ctx.cfg.aiModel, ...FALLBACK_MODELS])]) list.push(workersModel(ctx, m));
  }
  return list;
}

const JUDGE_PROMPT = `Ты проверяешь разборы операционного отчёта пиццерии Додо. Перед тобой изображение отчёта и несколько разборов, помеченных буквами.
Выбери ОДИН лучший разбор по правилам:
1) Числа нужной точки совпадают с отчётом на изображении (это главное: разбор с неверными числами — плохой).
2) Причины связаны с показателями, а не общие слова.
3) Действия конкретные, для менеджера пиццерии, со сроками; нет слов «проанализировать», «оптимизировать», «улучшить».
4) Коротко и по делу.
Ответь только JSON без пояснений вокруг: {"best": "<буква>", "why": "<одна короткая фраза по-русски>"}`;

// Судья выбирает лучший ответ; если судья не справился — берём первый
async function pickBest(judges, answers, image, location) {
  const letters = "ABCDEFGH";
  const prompt = `Точка: ${location || "вся сеть"}.\n\n` +
    answers.map((a, i) => `=== Разбор ${letters[i]} ===\n${a.text}`).join("\n\n");
  for (const judge of judges) {
    try {
      const reply = await judge.run(JUDGE_PROMPT, prompt, image, 2048);
      const m = reply.match(/"best"\s*:\s*"([A-H])"/) || reply.match(/\b([A-H])\b/);
      const index = m ? letters.indexOf(m[1]) : -1;
      if (index >= 0 && index < answers.length) {
        const why = (reply.match(/"why"\s*:\s*"([^"]*)"/) || [])[1] || "";
        return { ...answers[index], why, judge: judge.name };
      }
    } catch (e) {
      console.warn(`Судья ${judge.name} не ответил:`, String(e));
    }
  }
  return { ...answers[0], why: "", judge: "" };
}

async function analyze(ctx, job) {
  const bytes = await ctx.tg.download(job.file_id);
  const image = { mime: bytes[0] === 0x89 ? "image/png" : "image/jpeg", b64: toBase64(bytes) };
  const norms = await ctx.db.getSetting(normsKey(job.chat_id));
  let prompt = job.location
    ? `Разбери точку: ${job.location}. Остальные точки используй только для сравнения.`
    : "Точка не указана — разбери итог по сети и коротко отметь лучшую и худшую точки.";
  if (norms) prompt += `\nНормы: ${norms}`;
  if (job.caption) prompt += `\nКомментарий к фото: ${job.caption}`;

  // Все модели отвечают параллельно; ошибки собираем, чтобы показать причину
  const models = contestants(ctx);
  const results = await Promise.allSettled(models.map((m) => m.run(SYSTEM_PROMPT, prompt, image)));
  const answers = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) answers.push({ text: r.value, name: models[i].name });
    else errors.push(`${models[i].name}: ${r.status === "fulfilled" ? "пустой ответ" : String(r.reason?.message || r.reason).slice(0, 160)}`);
  });
  if (!answers.length) throw new Error(errors.join("; "));
  if (answers.length === 1) return { ...answers[0], why: "", judge: "", total: 1, errors };

  // Судья — самая сильная из ответивших моделей (порядок участников: Gemini, Kimi, Llama)
  const judges = models.filter((m) => answers.some((a) => a.name === m.name));
  return { ...(await pickBest(judges, answers, image, job.location)), total: answers.length, errors };
}

export async function processReportJobs(ctx) {
  if (!ctx.ai && !ctx.cfg.geminiKey) return;
  for (const job of await ctx.db.pendingReportJobs(JOBS_PER_RUN)) {
    // Помечаем заранее: если обработка упадёт посреди, задача не зациклится
    await ctx.db.bumpReportJob(job.id);
    try {
      const best = await analyze(ctx, job);
      const where = job.location ? `: ${esc(job.location)}` : " по сети";
      const who = best.total > 1 ? `лучший из ${best.total}: ${esc(best.name)}` : esc(best.name);
      const header = `🤖 <b>Разбор отчёта${where}</b> (${who}; запросил(а) ${mention(job.requested_by_id, job.requested_by)})\n\n`;
      let note = "";
      if (best.why) note += `\n\n<i>🏆 Почему выбран этот ответ: ${esc(best.why.slice(0, 200))}</i>`;
      // Какие модели не ответили и почему
      if (best.errors.length) note += `\n<i>⚠️ ${esc(best.errors.join("; ").slice(0, 400))}</i>`;
      await ctx.tg.edit(job.chat_id, job.placeholder_id, (header + esc(best.text)).slice(0, 3600) + note);
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

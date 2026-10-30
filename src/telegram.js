// Тонкая обёртка над Telegram Bot API.

export class TelegramError extends Error {}

export class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}/`;
  }

  async call(method, params = {}) {
    let body;
    let headers;
    if (params instanceof FormData) {
      body = params;
    } else {
      body = JSON.stringify(params);
      headers = { "content-type": "application/json" };
    }
    const res = await fetch(this.base + method, { method: "POST", body, headers });
    const data = await res.json();
    if (!data.ok) throw new TelegramError(`${method}: ${data.description}`);
    return data.result;
  }

  // Скачивает файл (например, фото) по file_id
  async download(fileId) {
    const file = await this.call("getFile", { file_id: fileId });
    const res = await fetch(this.base.replace("/bot", "/file/bot") + file.file_path);
    if (!res.ok) throw new TelegramError(`download: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Как call, но вместо ошибки возвращает null (например, админ не нажал /start)
  async safe(method, params) {
    try {
      return await this.call(method, params);
    } catch (e) {
      console.warn(String(e));
      return null;
    }
  }

  send(chatId, text, { thread = 0, replyTo = null, markup = null } = {}) {
    const params = { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
    if (thread) params.message_thread_id = thread;
    if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (markup) params.reply_markup = markup;
    return this.safe("sendMessage", params);
  }

  reply(msg, text, opts = {}) {
    return this.send(msg.chat.id, text, {
      thread: msg.is_topic_message ? msg.message_thread_id : 0,
      replyTo: msg.message_id,
      ...opts,
    });
  }

  edit(chatId, messageId, text, markup = null) {
    const params = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
    params.reply_markup = markup || { inline_keyboard: [] };
    return this.safe("editMessageText", params);
  }

  answer(callbackId, text = "", alert = false) {
    return this.safe("answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: alert });
  }

  del(chatId, messageId) {
    return this.safe("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
}

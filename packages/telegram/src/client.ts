/**
 * Telegram Bot API client.
 *
 * The bot token is a Worker secret. It appears only in the request URL to
 * api.telegram.org and is never logged or returned (CLAUDE.md §36, §47).
 */

import type { Logger } from '@corpus/shared'

const API_BASE = 'https://api.telegram.org'
const TIMEOUT_MS = 10_000
/** Telegram's own hard limit for a message body. */
const MAX_MESSAGE_CHARS = 4096

export interface TelegramClientOptions {
  logger: Logger
  /** Overridable for tests. */
  fetchImpl?: typeof fetch
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly options: TelegramClientOptions,
  ) {}

  get configured(): boolean {
    return this.token.length > 0
  }

  async sendMessage(chatId: string, text: string, options: { html?: boolean } = {}): Promise<boolean> {
    if (!this.configured) {
      this.options.logger.warn('telegram send skipped: bot token not configured', {
        action: 'telegram.send',
        result: 'not_configured',
      })
      return false
    }
    // Long answers are truncated rather than rejected by Telegram.
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, MAX_MESSAGE_CHARS),
      disable_web_page_preview: true,
    }
    if (options.html) body.parse_mode = 'HTML'
    return this.call('sendMessage', body)
  }

  async sendChatAction(chatId: string, action = 'typing'): Promise<boolean> {
    if (!this.configured) return false
    return this.call('sendChatAction', { chat_id: chatId, action })
  }

  /** Register the webhook. Called by `scripts/telegram-setup.ts`. */
  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
    })
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call('deleteWebhook', { drop_pending_updates: true })
  }

  async getWebhookInfo(): Promise<Record<string, unknown> | null> {
    const result = await this.callRaw('getWebhookInfo', {})
    return result && typeof result === 'object' ? (result as Record<string, unknown>) : null
  }

  private async call(method: string, body: Record<string, unknown>): Promise<boolean> {
    return (await this.callRaw(method, body)) !== null
  }

  private async callRaw(method: string, body: Record<string, unknown>): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const json = (await response.json()) as { ok?: boolean; result?: unknown; description?: string }
      if (!response.ok || json.ok !== true) {
        // The description can echo request content; log the method only.
        this.options.logger.warn('telegram api call failed', {
          action: 'telegram.api',
          result: 'error',
          method,
          status: response.status,
        })
        return null
      }
      return json.result ?? true
    } catch (e) {
      this.options.logger.warn('telegram api call threw', {
        action: 'telegram.api',
        result: 'exception',
        method,
        error: e instanceof Error ? e.name : 'unknown',
      })
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

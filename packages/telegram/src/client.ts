/**
 * Telegram Bot API client.
 *
 * The bot token is a Worker secret. It appears only in the request URL to
 * api.telegram.org and is never logged or returned (CLAUDE.md §36, §47).
 */

import type { Logger } from '@corpus/shared'

const API_BASE = 'https://api.telegram.org'
const TIMEOUT_MS = 10_000
/** A CV is larger than a JSON call, so downloads get their own budget. */
const DOWNLOAD_TIMEOUT_MS = 20_000
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

  /**
   * Download a file a user sent, in two steps as the Bot API requires:
   * `getFile` resolves an opaque `file_id` to a path, then the file is fetched
   * from the file endpoint.
   *
   * The download URL embeds the bot token, so it is never logged, returned or
   * put in an error message — only the resolved byte count is.
   */
  async downloadFile(fileId: string, maxBytes: number): Promise<ArrayBuffer | null> {
    if (!this.configured) return null

    const meta = (await this.callRaw('getFile', { file_id: fileId })) as
      | { file_path?: string; file_size?: number }
      | null
    const filePath = meta?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return null

    // Telegram reports the size up front, so an oversized file costs no transfer.
    if (typeof meta?.file_size === 'number' && meta.file_size > maxBytes) {
      this.options.logger.warn('telegram file exceeds the size limit', {
        action: 'telegram.download',
        result: 'too_large',
        bytes: meta.file_size,
      })
      return null
    }

    // A crafted file_path must not walk out of the file endpoint.
    if (filePath.includes('..')) {
      this.options.logger.error('telegram returned a traversal-shaped file path', {
        action: 'telegram.download',
        result: 'rejected_path',
      })
      return null
    }

    const fetchImpl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetchImpl(
        `${API_BASE}/file/bot${this.token}/${filePath}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        this.options.logger.warn('telegram file download failed', {
          action: 'telegram.download',
          result: 'error',
          status: response.status,
        })
        return null
      }
      const body = await response.arrayBuffer()
      if (body.byteLength > maxBytes) {
        this.options.logger.warn('telegram file exceeded the size limit after download', {
          action: 'telegram.download',
          result: 'too_large',
          bytes: body.byteLength,
        })
        return null
      }
      return body
    } catch (e) {
      this.options.logger.warn('telegram file download threw', {
        action: 'telegram.download',
        result: 'exception',
        error: e instanceof Error ? e.name : 'unknown',
      })
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Replace the bot's command menu.
   *
   * Telegram has no "add one" call — the list is set wholesale, so the caller
   * must always send the built-ins alongside anything curated, or they vanish
   * from the menu.
   */
  async setMyCommands(commands: readonly { command: string; description: string }[]): Promise<boolean> {
    return this.call('setMyCommands', {
      commands: commands.map((c) => ({ command: c.command, description: c.description })),
      scope: { type: 'all_private_chats' },
    })
  }

  async getMyCommands(): Promise<{ command: string; description: string }[] | null> {
    const result = await this.callRaw('getMyCommands', { scope: { type: 'all_private_chats' } })
    if (!Array.isArray(result)) return null
    return result.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const row = entry as { command?: unknown; description?: unknown }
      if (typeof row.command !== 'string') return []
      return [{ command: row.command, description: String(row.description ?? '') }]
    })
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

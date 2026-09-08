/** The subset of the Telegram Bot API we consume. Untrusted input throughout. */

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface NormalisedUpdate {
  updateId: number
  telegramUserId: string
  chatId: string
  chatType: TelegramChat['type']
  text: string
  command: string | null
  commandArgs: string
  /** Display name, retained only for logging — never used for authorisation. */
  displayName: string
  isBot: boolean
}

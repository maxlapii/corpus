/**
 * Password hashing with PBKDF2-SHA256 via WebCrypto.
 *
 * PBKDF2 is used rather than bcrypt/argon2 because it is available natively in
 * the Workers runtime with no native module, keeping the $0-hosting constraint
 * (CLAUDE.md §3). The iteration count is stored alongside the hash so it can be
 * raised later without invalidating existing credentials.
 */

import { base64UrlDecode, base64UrlEncode, timingSafeEqual } from '@corpus/shared'

const ALGORITHM = 'pbkdf2-sha256'
const DEFAULT_ITERATIONS = 210_000
const SALT_BYTES = 16
const KEY_BITS = 256

export interface PasswordPolicyIssue {
  code: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_SIMPLE' | 'COMMON'
  message: string
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
  'letmein', 'welcome1', 'admin123', 'changeme', 'iloveyou', 'passw0rd',
])

/** Minimum viable password policy. Enforced server-side on every change. */
export function checkPasswordPolicy(password: string): PasswordPolicyIssue[] {
  const issues: PasswordPolicyIssue[] = []
  if (password.length < 12) {
    issues.push({ code: 'TOO_SHORT', message: 'Password must be at least 12 characters.' })
  }
  if (password.length > 200) {
    issues.push({ code: 'TOO_LONG', message: 'Password must be at most 200 characters.' })
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length
  if (classes < 3) {
    issues.push({
      code: 'TOO_SIMPLE',
      message: 'Password must mix at least three of: lower case, upper case, digits, symbols.',
    })
  }
  if (COMMON.has(password.toLowerCase())) {
    issues.push({ code: 'COMMON', message: 'That password is too common.' })
  }
  return issues
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** Encoded as `algorithm$iterations$salt$hash`, all base64url. */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)
  const hash = await derive(password, salt, iterations)
  return `${ALGORITHM}$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`
}

/**
 * Verify a password. Returns false for malformed or absent hashes rather than
 * throwing, so a user without a password simply cannot authenticate.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = parts as [string, string, string, string]
  if (algorithm !== ALGORITHM) return false
  const iterations = Number(iterationsRaw)
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) return false

  let salt: Uint8Array
  try {
    salt = base64UrlDecode(saltRaw)
  } catch {
    return false
  }
  const actual = await derive(password, salt, iterations)
  return timingSafeEqual(base64UrlEncode(actual), hashRaw)
}

/** True when a stored hash was produced with weaker parameters than current. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4) return true
  return Number(parts[1]) < DEFAULT_ITERATIONS
}

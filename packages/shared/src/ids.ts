/**
 * Identifier helpers. Uses WebCrypto, which exists in both Workers and Node 20+.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz' // Crockford-ish, no i/l/o/u

/** Random URL-safe identifier of `size` characters (default 22 ≈ 110 bits). */
export function randomId(size = 22): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i]! & 31]
  return out
}

/** Prefixed identifier, e.g. `emp_3k9...`. Prefix aids log readability. */
export function prefixedId(prefix: string, size = 18): string {
  return `${prefix}_${randomId(size)}`
}

export const newUuid = (): string => crypto.randomUUID()

/** Numeric code for e-mail verification. Cryptographically random, no modulo bias. */
export function randomNumericCode(digits = 6): string {
  let out = ''
  const buf = new Uint8Array(1)
  while (out.length < digits) {
    crypto.getRandomValues(buf)
    const v = buf[0]!
    if (v >= 250) continue // reject to keep the distribution uniform over 0..9
    out += String(v % 10)
  }
  return out
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64UrlEncode(buf)
}

export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

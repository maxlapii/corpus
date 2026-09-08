/**
 * Rate-limit key from the client address (CLAUDE.md §45).
 *
 * Only `CF-Connecting-IP` is trusted — `X-Forwarded-For` is caller-controlled,
 * so honouring it would let one client bypass every per-IP limit by rotating
 * the header. Without an edge header, callers share the `unknown` bucket.
 */
export function clientIpKey(headers: {
  get?(name: string): string | null
  header?(name: string): string | undefined
}): string {
  const read = (name: string): string | undefined =>
    headers.header ? headers.header(name) : (headers.get?.(name) ?? undefined)

  const edgeAddress = read('cf-connecting-ip')
  const MAX_IP_LENGTH = 45 // IPv6 with an embedded IPv4 suffix

  return edgeAddress && edgeAddress.length <= MAX_IP_LENGTH ? edgeAddress : 'unknown'
}

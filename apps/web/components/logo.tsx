/**
 * CORPUS logo mark, inline so it needs no image request and scales crisply.
 * The favicon in app/icon.svg is the same artwork.
 *
 * Concept: one body, many members. Six people around a shared core, bound by
 * a faint ring — the organisation as "corpus". No background; the mark takes
 * the brand colour from the stylesheet and sits on whatever surface it is on.
 */

export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const color = 'var(--accent)'
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <circle cx="32" cy="32" r="17" fill="none" stroke={color} strokeWidth="2.5" opacity="0.35" />
      <circle cx="32.0" cy="15.0" r="5.6" fill={color} />
      <circle cx="46.7" cy="23.5" r="5.6" fill={color} />
      <circle cx="46.7" cy="40.5" r="5.6" fill={color} />
      <circle cx="32.0" cy="49.0" r="5.6" fill={color} />
      <circle cx="17.3" cy="40.5" r="5.6" fill={color} />
      <circle cx="17.3" cy="23.5" r="5.6" fill={color} />
      <circle cx="32" cy="32" r="7" fill={color} />
    </svg>
  )
}

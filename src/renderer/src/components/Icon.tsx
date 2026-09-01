import React from 'react'

/** Material Symbols Outlined glyph (self-hosted font). */
export function I({
  name,
  size,
  className,
  style
}: {
  name: string
  size?: number
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  return (
    <span
      className={`msym ${className ?? ''}`}
      style={size ? { fontSize: size, ...style } : style}
      aria-hidden="true"
    >
      {name}
    </span>
  )
}

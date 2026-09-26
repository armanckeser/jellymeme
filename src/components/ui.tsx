'use client'

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

/*
 * The entire component library. Hand-rolled on purpose: this app needs five
 * primitives, and a component framework would be more dependency surface than
 * the UI it renders.
 */

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(' ')

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  size?: 'sm' | 'md'
}

export function Button({
  variant = 'subtle',
  size = 'md',
  className,
  ...props
}: ButtonProps) {
  const variants = {
    primary: 'bg-accent text-base font-semibold hover:brightness-110 disabled:hover:brightness-100',
    subtle: 'bg-raised text-ink hover:bg-line',
    ghost: 'bg-transparent text-muted hover:text-ink hover:bg-raised',
    danger: 'bg-transparent text-danger hover:bg-danger/10',
  }
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg transition-colors',
        // A label must never wrap: in a flex row next to an input the button gets
        // squeezed, and "Find it" became two lines.
        'shrink-0 whitespace-nowrap',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink',
        'placeholder:text-faint focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink',
        'placeholder:text-faint focus:border-accent focus:outline-none resize-y',
        className,
      )}
      {...props}
    />
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx('rounded-card border border-line bg-surface', className)}>{children}</div>
  )
}

export function Banner({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success'
  children: ReactNode
}) {
  const tones = {
    error: 'border-danger/40 bg-danger/10 text-danger',
    info: 'border-line bg-raised text-muted',
    success: 'border-accent/40 bg-accent/10 text-accent',
  }
  return (
    <div className={cx('rounded-lg border px-3.5 py-2.5 text-sm', tones[tone])} role="status">
      {children}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted">
      <span
        className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden
      />
      {label}
    </span>
  )
}

export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {children && <div className="mt-1.5 text-sm text-faint">{children}</div>}
    </div>
  )
}

/*
 * Icons.
 *
 * Hand-drawn rather than a package, for the same reason as the components: this
 * is seven glyphs. They replace the text characters the UI used to use (▶, ✕,
 * ↑), which render at whatever weight the system font feels like and are the
 * main reason the app looked unfinished.
 */
function Glyph({ path, label }: { path: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={path} />
    </svg>
  )
}

export const Icon = {
  Play: () => (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.2-4.8a.6.6 0 0 0 0-1l-7.2-4.8A.6.6 0 0 0 5 3.2Z" />
    </svg>
  ),
  Pause: () => (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M4.5 3h2.2v10H4.5zM9.3 3h2.2v10H9.3z" />
    </svg>
  ),
  Up: () => <Glyph path="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" />,
  Down: () => <Glyph path="M8 3v10m0 0 4.5-4.5M8 13l-4.5-4.5" />,
  Close: () => <Glyph path="M4 4l8 8M12 4l-8 8" />,
  Check: () => <Glyph path="M3 8.5 6.5 12 13 4.5" />,
  Search: () => <Glyph path="M11 11l3 3M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z" />,
  Plus: () => <Glyph path="M8 3v10M3 8h10" />,
  Chevron: ({ open }: { open: boolean }) => (
    <span className={cx('inline-block transition-transform', open && 'rotate-90')}>
      <Glyph path="M6 3.5 10.5 8 6 12.5" />
    </span>
  ),
}

/** mm:ss, or h:mm:ss past an hour. Used everywhere timestamps are shown. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function episodeLabel(season: number | null, episode: number | null, name: string): string {
  if (season == null || episode == null) return name
  const pad = (n: number) => String(n).padStart(2, '0')
  return `S${pad(season)}E${pad(episode)} · ${name}`
}

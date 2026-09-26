import { describe, it, expect } from 'vitest'
import { renderErrorMessage } from './ffmpeg'

/*
 * What a failed render tells the user.
 *
 * This exists because of a failure that was invisible from every side at once:
 * clicking a clip returned `{"error":""}`, `next start` logs nothing per
 * request, and the ffmpeg binary ran `-version` perfectly. The message was lost
 * to `explain(stderr) ?? tail ?? message` — `??` falls through on null and
 * undefined, but `tail` is a string that is empty exactly when ffmpeg crashed
 * before writing to stderr, which is precisely the case with no other evidence.
 *
 * So the rule under test is: whatever happened, say something.
 */

describe('describing a failed ffmpeg run', () => {
  it('never returns an empty message, however little there is to go on', () => {
    expect(renderErrorMessage('', null, '')).not.toBe('')
  })

  it('names the cause when ffmpeg crashed with nothing on stderr', () => {
    // The real case: a statically linked ffmpeg segfaulting on a hostname. It
    // dies mid-instruction, so stderr is empty and the signal is all there is.
    const message = renderErrorMessage('', 'SIGSEGV', 'Command failed: /app/.../ffmpeg -i http://...')

    expect(message).toContain('SIGSEGV')
    expect(message).toContain('JELLYMEME_FFMPEG')
  })

  it('reports any other signal rather than passing off a bare exec message', () => {
    expect(renderErrorMessage('', 'SIGKILL', 'Command failed')).toContain('SIGKILL')
  })

  it('prefers a real diagnosis on stderr to an inference from the signal', () => {
    // A crash after ffmpeg had already said something useful: what it said wins,
    // because it is evidence rather than a guess about the one common cause.
    const message = renderErrorMessage(
      'Error opening input: Server returned 401 Unauthorized',
      'SIGSEGV',
      'Command failed',
    )

    expect(message).toContain('401')
    expect(message).not.toContain('SIGSEGV')
  })

  it('falls back to the tail of stderr when nothing is recognised', () => {
    const stderr = 'line one\n\nline two\nconv1d: unexpected shape\n'
    expect(renderErrorMessage(stderr, null, 'Command failed')).toContain('conv1d: unexpected shape')
  })

  it('uses the exec message when ffmpeg exited quietly', () => {
    expect(renderErrorMessage('', null, 'spawn ffmpeg ENOENT')).toBe('spawn ffmpeg ENOENT')
  })
})

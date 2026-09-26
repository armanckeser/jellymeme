/**
 * Turns pasted text into a list of scene descriptions.
 *
 * The input this is designed for is a Reddit thread: "what's your favourite
 * scene in X" answers, copied wholesale. That arrives as numbered lists,
 * bullets, blockquotes, one-per-line answers, or a single run-on paragraph,
 * usually sprinkled with usernames and markdown. Anything that survives this
 * function becomes one clip in the montage, so it errs toward keeping text and
 * only drops what is clearly not a description.
 */

import { episodeNamed, QUOTED_SPAN, type EpisodeRef } from './hints'

const LIST_MARKER = /^\s*(?:[-–—*•·>]+\s*|\d{1,3}\s*[.)\]:]\s+|#\d{1,3}\s+)/
// The optional leading slash must be matched before the word boundary, or
// "/u/name" leaves a stray "/" behind.
const REDDIT_HANDLE = /\/?\b(?:u|r)\/[A-Za-z0-9_-]+/g
const EDIT_SUFFIX = /\b(?:edit|eta)\s*\d*\s*[:—-].*$/is
const SCORE_LINE = /^\s*[\d.,]+k?\s*(?:points?|upvotes?|likes?)\b/i

/*
 * Reddit's own furniture, plus chatter that answers nothing.
 *
 * Most of the furniture is too short to clear the three-word floor in `isUsable`,
 * so "View More", a bare advertiser domain and a bare "Ad" need no rule here.
 * These two do, because they are ordinary words of ordinary length: "8 more
 * replies" is a button, and "Thumbnail image: ..." is an advert's alt text. Each
 * one that survives costs an embedding, a vector search, and then two Jellyfin
 * transcodes once the editor opens.
 */
const NOISE_LINE =
  /^\s*(?:\[?(?:deleted|removed)\]?|reply|share|report|save|follow|edit|continue this thread.*|load more comments.*|\d+\s+more\s+repl(?:y|ies)|thumbnail image:.*|level \d+|op|this\.?|same|agreed?|lol|lmao|underrated|scrolled too far for this)\s*[.!]*\s*$/i

/**
 * A line introducing whatever comes next: "Funniest and most quoted by me:".
 *
 * It describes the answer instead of being it, so it matches no dialogue.
 * Deliberately narrow — the colon has to be the last character, which leaves
 * "Also: the diner scene" alone.
 */
const PREAMBLE_LINE = /:\s*$/

const PROMOTED_START = /^(?:ad|promoted)$/i
/** Either of the two lines Reddit closes a promoted post with: the alt text, or the advertiser's domain. */
const PROMOTED_END = /^thumbnail image:|^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
/** Enough for the five lines Reddit actually emits, without reaching into the next comment. */
const PROMOTED_MAX_LINES = 12

function promotedBlockEnd(lines: string[], start: number): number | null {
  const limit = Math.min(start + PROMOTED_MAX_LINES, lines.length)
  for (let index = start + 1; index < limit; index++) {
    if (PROMOTED_END.test(lines[index].trim())) return index
  }
  return null
}

/**
 * Removes promoted posts, which no pattern can recognise by their words.
 *
 * The copy is ordinary English: "Shifts that fit around your schedule" is indistinguishable
 * from a scene description, and it sits in the middle of the thread wearing the same
 * clothes as an answer. So this reads the block's shape instead. Reddit emits a bare
 * `Ad` line, the copy, a call to action, the advertiser's domain, and finally the
 * thumbnail's alt text repeating the copy.
 *
 * Everything from `Ad` to the closing line goes. An `Ad` with no closing line nearby
 * is left alone rather than guessed at, because the failure worth avoiding is one
 * stray marker swallowing the rest of the thread.
 */
function dropPromotedBlocks(lines: string[]): string[] {
  const kept: string[] = []
  let index = 0

  while (index < lines.length) {
    const end = PROMOTED_START.test(lines[index].trim()) ? promotedBlockEnd(lines, index) : null
    if (end === null) {
      kept.push(lines[index])
      index += 1
      continue
    }
    index = end + 1
  }

  return kept
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*\*|\*\*|\*|__|_|~~)/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .trim()
}

function normalise(line: string): string {
  let text = line

  // Blockquote and list markers can nest: "> - 1. the scene where..."
  let previous: string
  do {
    previous = text
    text = text.replace(LIST_MARKER, '')
  } while (text !== previous)

  return stripMarkdown(text)
    .replace(REDDIT_HANDLE, ' ')
    .replace(EDIT_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A whole line wrapped in single quotes, which the span pattern deliberately ignores. */
const WRAPPED_IN_SINGLE_QUOTES = /^['‘]([^'‘’]+)['’]$/

interface Candidate {
  text: string
  /** A quoted span inside a line, or the whole line. Changes how it may be split. */
  source: 'quote' | 'line'
}

/**
 * The descriptions one cleaned line yields.
 *
 * A thread answer is usually a quote with commentary welded to it — *"Sorry, I
 * can't stop once I start." Bulletproof!* — and the quote is the half that matches
 * dialogue. The rest is about the scene rather than in it, so searching for it
 * finds nothing.
 *
 * Several quotes in one line become several descriptions. Dropping one is a click;
 * recovering one that was never offered means retyping it.
 *
 * Lines with no quote at all are kept whole, because plenty of real descriptions
 * are unquoted prose: "the one where he turns himself into a pickle".
 *
 * The exception is a quote that names an episode. "Marnie and Charlie riding the
 * subway in 'the panic in Central Park.'" was searched as the bare title — spoken
 * by nobody, so it found the wrong scene — while the sentence naming two
 * characters and a subway was discarded. An episode name is an address rather
 * than something said, so it does not displace the line it sits in, and the
 * search scopes itself to that episode instead. Only the show's own episode list
 * can tell the two apart, which is why it has to be passed in.
 */
function descriptionsIn(line: string, episodes: EpisodeRef[]): Candidate[] {
  const quoted = [...line.matchAll(QUOTED_SPAN)]
    .map((match) => match[1].trim())
    .filter((text) => !episodeNamed(text, episodes))
    .map((text): Candidate => ({ text, source: 'quote' }))
    .filter((candidate) => isUsable(candidate.text))

  if (quoted.length > 0) return quoted

  const wrapped = WRAPPED_IN_SINGLE_QUOTES.exec(line)
  return [{ text: wrapped ? wrapped[1].trim() : line, source: 'line' }]
}

function isUsable(text: string): boolean {
  if (text.length < 8) return false
  if (SCORE_LINE.test(text)) return false
  if (NOISE_LINE.test(text)) return false
  if (PREAMBLE_LINE.test(text)) return false
  // Needs at least a couple of real words, not just punctuation or emoji.
  const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w))
  return words.length >= 3
}

/** Splits a run-on paragraph on sentence boundaries, keeping the terminator. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“'(])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Most descriptions one paste can produce.
 *
 * Each becomes an embedding and a vector search, so this bounds what a single
 * paste of a very long thread can cost.
 */
export const MAX_DESCRIPTIONS = 60

export interface SplitOptions {
  /** Below this, a single-block paste is treated as one description, not split. */
  runOnThreshold?: number
  maxDescriptions?: number
  /**
   * The show's episodes, when the caller knows which show this is about.
   *
   * Only used to tell a quoted episode title from quoted dialogue. Omitted, every
   * quote is treated as dialogue, which is the behaviour this had before.
   */
  episodes?: EpisodeRef[]
}

export function splitSceneDescriptions(input: string, options: SplitOptions = {}): string[] {
  const { runOnThreshold = 200, maxDescriptions = MAX_DESCRIPTIONS, episodes = [] } = options
  const body = input.replace(/\r\n?/g, '\n')
  if (!body.trim()) return []

  let candidates = dropPromotedBlocks(body.split('\n'))
    .map(normalise)
    .flatMap((line) => descriptionsIn(line, episodes))
    .filter((candidate) => isUsable(candidate.text))

  // A single long paragraph is someone listing several scenes in prose; the
  // line-based split cannot see the boundaries, so fall back to sentences. Never
  // for a quote — its quotation marks already said where it ends, and a quote
  // spanning three sentences is still one thing somebody said.
  const only = candidates.length === 1 ? candidates[0] : null
  if (only?.source === 'line' && only.text.length > runOnThreshold) {
    const sentences = splitSentences(only.text)
      .map((text): Candidate => ({ text, source: 'line' }))
      .filter((candidate) => isUsable(candidate.text))
    if (sentences.length > 1) candidates = sentences
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const { text } of candidates) {
    const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(text)
    if (unique.length >= maxDescriptions) break
  }

  return unique
}

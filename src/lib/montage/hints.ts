/**
 * Reads the location out of a scene description.
 *
 * Nobody describes a scene and then separately states which episode it is in.
 * They write "Marnie and Charlie riding the subway in 'the panic in Central
 * Park'", or "the closing scene of s5 e3", or "the ending scene to Beach House" —
 * the where is welded to the what. Discarding it means searching nineteen
 * thousand lines of dialogue for a moment whose address we were handed.
 *
 * Everything here is a hint and never a filter. Search prefers what this returns
 * and falls back to plain ranking, because a half-remembered episode name has to
 * still find the scene.
 *
 * No Node imports: the browser calls this to show what was understood before
 * thirty searches run, and the server calls it because it does not trust the
 * browser. Both have to get the same answer.
 */

/** An episode as this module needs to see it. Structurally a subset of `TitleVideo`. */
export interface EpisodeRef {
  id: string
  name: string
  season: number | null
  episode: number | null
}

/** Where in the library a description pointed, as videos to prefer plus words to say back. */
export interface Where {
  /** One episode, or a whole season's worth. */
  videoIds: string[]
  /** A noun phrase that reads after "in": "Hello Kitty (S5E7)", "season 5". */
  label: string
}

/** Where in an episode, for the descriptions that say. An enum because a scene has neither by default. */
export type When = 'opening' | 'ending'

export interface SceneRequest {
  /** What actually gets embedded, with any episode name that acted as an address removed. */
  text: string
  where: Where | null
  when: When | null
}

/**
 * A quoted span inside a line.
 *
 * Straight and curly double quotes only, never the apostrophe. Anchored to both
 * ends of a line an apostrophe is survivable; as a *span* pattern it would turn
 * "He's got it, it's fine" into "s got it, it".
 *
 * Lives here rather than in split.ts because both modules ask the same question
 * of a line and the answer must not differ between them.
 */
export const QUOTED_SPAN = /["“]([^"“”]+)["”]/g

/**
 * An unquoted episode name has to be at least this many words.
 *
 * Girls has episodes called Boys, Flo, Iowa, Japan, Together, Gummies and Pilot.
 * Case alone does not protect against those, because the first word of a sentence
 * is capitalised anyway: "Together they walk out of the diner" would scope itself
 * to season 2 episode 10. Two words is what makes a name in prose a claim rather
 * than a coincidence.
 */
const MIN_UNQUOTED_NAME_WORDS = 2

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}

/**
 * Season and episode written as numbers.
 *
 * The bare `s` has to sit directly against its digits. Allowing "s 5" makes an
 * apostrophe into a season marker, because `\b` matches after one: "it's 10
 * minutes in" would read as season 10.
 */
const SEASON_EPISODE = [
  /\bs(\d{1,2})\s*(?:ep(?:isode)?|e)\s*(\d{1,2})\b/i,
  /\bseason\s*(\d{1,2})\s*,?\s*(?:ep(?:isode)?|e)\s*(\d{1,2})\b/i,
  /\b(\d{1,2})x(\d{1,2})\b/i,
]

const SEASON_ONLY = [/\bs(\d{1,2})\b/i, /\bseason\s*(\d{1,2})\b/i]
const SEASON_WORD = /\bseason\s+([a-z]+)\b/i

/** Resolved against a known season only. "The finale" alone is ambiguous, and a wrong episode is worse than none. */
const LAST_EPISODE = /\b(?:finale|final episode|last episode)\b/i
const FIRST_EPISODE = /\b(?:premiere|première|first episode)\b/i

const OPENING =
  /\bcold open\b|\bopening (?:scene|shot|sequence|moments?)\b|\bthe opening\b|\bfirst scene\b|\bvery beginning\b|\bopens? with\b/i
/*
 * "the ending" and "ending scene", but never a bare "ending": "rays happy ending
 * in meeting Abigail" is a description of an arc, not of a position in an episode.
 */
const ENDING =
  /\bclosing (?:scene|shot|moments?)\b|\bending scene\b|\bthe ending\b|\bfinal scene\b|\blast scene\b|\bcredits scene\b|\bat the (?:very )?end\b|\bthe very end\b/i

const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g

/** Jellyfin's episode names carry straight apostrophes; people type curly ones, and sometimes the reverse. */
const straightenQuotes = (text: string): string => text.replace(/[’‘]/g, "'")

/** Trailing punctuation lands inside the quotes: "Japan," and "the panic in Central Park." */
const trimTrailingPunctuation = (text: string): string => text.replace(/[.,!?;:\s]+$/, '')

const comparisonKey = (text: string): string =>
  trimTrailingPunctuation(straightenQuotes(text).trim()).toLowerCase()

function episodeLabel(episode: EpisodeRef): string {
  if (episode.season === null || episode.episode === null) return episode.name
  return `${episode.name} (S${episode.season}E${episode.episode})`
}

const asWhere = (episode: EpisodeRef): Where => ({
  videoIds: [episode.id],
  label: episodeLabel(episode),
})

/**
 * The episode a quoted span names, if it names one.
 *
 * This is the question no pattern can answer and the database can: a quoted span
 * is either an episode title or something a character said, and the only
 * difference is whether the show has an episode by that name. Exported because
 * split.ts has to ask it before deciding whether a quote is dialogue worth
 * searching for or an address worth stripping.
 */
export function episodeNamed(quoted: string, episodes: EpisodeRef[]): EpisodeRef | null {
  const key = comparisonKey(quoted)
  if (!key) return null
  return episodes.find((episode) => comparisonKey(episode.name) === key) ?? null
}

/**
 * An episode name sitting in running prose, with no quotes to mark it.
 *
 * Case-sensitive, and the reverse asymmetry is deliberate: matching "together"
 * against the episode *Together* sends the search to the wrong episode, while
 * missing "the beach house" written in lower case only costs the hint and falls
 * back to ranking the whole show. A false negative is cheap here and a false
 * positive is not.
 */
function unquotedEpisode(line: string, episodes: EpisodeRef[]): EpisodeRef | null {
  const candidates = episodes.filter(
    (episode) => episode.name.trim().split(/\s+/).length >= MIN_UNQUOTED_NAME_WORDS,
  )

  // Longest first, so "Hello Kitty" is not shadowed by a shorter name inside it.
  const byLength = [...candidates].sort((a, b) => b.name.length - a.name.length)
  const haystack = straightenQuotes(line)

  return (
    byLength.find((episode) => {
      const name = straightenQuotes(episode.name).replace(REGEX_METACHARACTERS, '\\$&')
      return new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`).test(haystack)
    }) ?? null
  )
}

function seasonNumber(line: string): number | null {
  for (const pattern of SEASON_ONLY) {
    const found = pattern.exec(line)
    if (found) return Number(found[1])
  }
  const word = SEASON_WORD.exec(line)
  return word ? (WORD_NUMBERS[word[1].toLowerCase()] ?? null) : null
}

function numberedEpisode(line: string, episodes: EpisodeRef[]): EpisodeRef | null {
  for (const pattern of SEASON_EPISODE) {
    const found = pattern.exec(line)
    if (!found) continue
    const [season, episode] = [Number(found[1]), Number(found[2])]
    const match = episodes.find((e) => e.season === season && e.episode === episode)
    if (match) return match
  }
  return null
}

/**
 * A season's worth of episodes, narrowed to one when the line says which end.
 *
 * "The S5 finale" is as precise as an episode name and arrives far more often
 * than one, so it is worth resolving rather than leaving as ten episodes.
 */
function seasonWhere(line: string, episodes: EpisodeRef[]): Where | null {
  const season = seasonNumber(line)
  if (season === null) return null

  const inSeason = episodes.filter((episode) => episode.season === season)
  if (inSeason.length === 0) return null

  const numbered = inSeason.filter((episode) => episode.episode !== null)
  const ordered = [...numbered].sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))

  if (ordered.length > 0 && LAST_EPISODE.test(line)) return asWhere(ordered[ordered.length - 1])
  if (ordered.length > 0 && FIRST_EPISODE.test(line)) return asWhere(ordered[0])

  return { videoIds: inSeason.map((episode) => episode.id), label: `season ${season}` }
}

function readWhen(line: string): When | null {
  const found: When[] = []
  if (OPENING.test(line)) found.push('opening')
  if (ENDING.test(line)) found.push('ending')
  // Both at once is a description we cannot place, so it gets no bias either way.
  return found.length === 1 ? found[0] : null
}

/**
 * Removes a quoted episode name from the text, leaving what describes the scene.
 *
 * This is the whole point of telling a quoted title from quoted dialogue. "the
 * panic in Central Park." is spoken by nobody, so searching for it finds the
 * wrong scene or none; the sentence around it — "Marnie and Charlie riding the
 * subway in" — is real signal, and it was being thrown away.
 */
function withoutQuotedNames(line: string, episodes: EpisodeRef[]): string {
  const stripped = line.replace(QUOTED_SPAN, (whole, inner: string) =>
    episodeNamed(inner, episodes) ? ' ' : whole,
  )
  return stripped.replace(/\s+/g, ' ').trim()
}

/**
 * Splits a description into what to search for and where to look.
 *
 * An explicit episode name outranks season and episode numbers, because someone
 * who remembers the title is more likely to be right than someone counting
 * episodes. On real threads the two agree whenever both appear.
 */
export function readSceneRequest(line: string, episodes: EpisodeRef[]): SceneRequest {
  const when = readWhen(line)

  const quoted = [...line.matchAll(QUOTED_SPAN)]
    .map((match) => episodeNamed(match[1], episodes))
    .find((episode) => episode !== null)

  if (quoted) {
    const text = withoutQuotedNames(line, episodes)
    // A description that was *only* an episode name leaves nothing to search
    // for. Keeping the name beats an empty query, and the scope does the work.
    return { text: text || line.trim(), where: asWhere(quoted), when }
  }

  const named = unquotedEpisode(line, episodes) ?? numberedEpisode(line, episodes)
  const where = named ? asWhere(named) : seasonWhere(line, episodes)

  return { text: line.trim(), where, when }
}

import { describe, it, expect } from 'vitest'
import { episodeNamed, readSceneRequest, type EpisodeRef } from './hints'

/*
 * A slice of the real Girls episode list, chosen for what it makes hard.
 *
 * Together, Japan and Boys are ordinary English words that happen to be episode
 * titles, which is the whole reason the unquoted rule is as strict as it is.
 */
const episode = (id: string, name: string, season: number, number: number): EpisodeRef => ({
  id,
  name,
  season,
  episode: number,
})

const GIRLS: EpisodeRef[] = [
  episode('v1', 'Vagina Panic', 1, 2),
  episode('v2', "Hannah's Diary", 1, 4),
  episode('v3', 'Boys', 2, 6),
  episode('v4', 'Together', 2, 10),
  episode('v5', 'Beach House', 3, 7),
  episode('v6', 'Japan', 5, 3),
  episode('v7', 'The Panic in Central Park', 5, 6),
  episode('v8', 'Hello Kitty', 5, 7),
  episode('v9', 'I Love You Baby', 5, 10),
  episode('v10', 'American Bitch', 6, 3),
  episode('v11', 'Full Disclosure', 6, 6),
  episode('v12', 'What Will We Do This Time About Adam?', 6, 8),
]

/*
 * The ambiguity no pattern can settle: a quoted span is either an episode title
 * or something a character said, and only the show's episode list knows which.
 * Everything else in this module is downstream of getting that right.
 */
describe('episodeNamed', () => {
  it.each([
    ['exactly', 'Hello Kitty'],
    ['in lower case, which is how people type it', 'hello kitty'],
    ['with the full stop that landed inside the quotes', 'the panic in Central Park.'],
    ['with a trailing comma', 'Japan,'],
    ['with a curly apostrophe where the name has a straight one', 'Hannah’s Diary'],
    ['with surrounding whitespace', '  Beach House  '],
    ['when the name itself ends in punctuation', 'What Will We Do This Time About Adam?'],
  ])('recognises an episode named %s', (_case, quoted) => {
    expect(episodeNamed(quoted, GIRLS)).not.toBeNull()
  })

  it.each([
    ['a song title', 'Past Lives'],
    ['real dialogue', "Sorry, I can't stop once I start."],
    ['a partial name', 'Hello'],
    ['a name with extra words welded on', 'Hello Kitty and friends'],
    ['nothing at all', '   '],
  ])('does not recognise %s', (_case, quoted) => {
    expect(episodeNamed(quoted, GIRLS)).toBeNull()
  })

  it('finds nothing when the show has no episode list yet', () => {
    expect(episodeNamed('Hello Kitty', [])).toBeNull()
  })
})

describe('readSceneRequest', () => {
  const read = (line: string) => readSceneRequest(line, GIRLS)

  /*
   * The regression this whole slice exists for. The quoted title was replacing the
   * description, so this searched for a string spoken by nobody and threw away the
   * sentence naming two characters and a subway.
   */
  it('turns a quoted episode title into scope and keeps the description', () => {
    const request = read('Marnie and Charlie riding the subway in “the panic in Central Park.”')

    expect(request.where?.videoIds).toEqual(['v7'])
    expect(request.where?.label).toBe('The Panic in Central Park (S5E6)')
    expect(request.text).toBe('Marnie and Charlie riding the subway in')
  })

  it('leaves a quoted song title in the search text, having no episode by that name', () => {
    const request = read('the scene where Shoshanna stays while “Past Lives” by BØRNS plays')

    expect(request.where).toBeNull()
    expect(request.text).toContain('“Past Lives”')
  })

  it('strips only the title, when one line quotes both a title and a song', () => {
    // Both are quoted spans; only one is an address.
    const request = read('the closing scene of s5 e3 "Japan," while "Past Lives" by BØRNS plays')

    expect(request.where?.videoIds).toEqual(['v6'])
    expect(request.text).not.toContain('"Japan,"')
    expect(request.text).toContain('"Past Lives"')
  })

  it('keeps the title as the search text when the description was nothing else', () => {
    // Scope with an empty query would rank an episode's dialogue against nothing.
    const request = read('“Hello Kitty”')

    expect(request.where?.videoIds).toEqual(['v8'])
    expect(request.text).toBe('“Hello Kitty”')
  })

  it('reads an unquoted title written in title case', () => {
    const request = read('The ending scene to Beach House')

    expect(request.where?.videoIds).toEqual(['v5'])
    expect(request.when).toBe('ending')
  })

  /*
   * Measured false positives, all from one real thread. Each of these words is an
   * episode title of this show, and none of these sentences is about that episode.
   */
  it.each([
    ['together', 'Hannah and Jessa in the bath together after Jessa breaks up with Thomas John'],
    ['boys', 'the bit where the boys go to the loft party'],
    ['japan', 'when she decides to stay in japan for good'],
    ['beach house', 'the morning after their huge blowout fight at the beach house'],
  ])('does not read “%s” in running prose as an episode title', (_word, line) => {
    expect(read(line).where).toBeNull()
  })

  /*
   * Case cannot guard a one-word title, because the first word of a sentence is
   * capitalised regardless. This is what the two-word floor is actually for.
   */
  it('does not read a capitalised one-word title starting a sentence as an episode', () => {
    expect(read('Together they walk out of the diner and it is perfect').where).toBeNull()
  })

  it('still reads a one-word title when it is quoted, since the quotes mark it', () => {
    // The case rule guards prose. A quote is already an explicit claim.
    expect(read('the ending of “japan”').where?.videoIds).toEqual(['v6'])
  })

  it.each([
    ['S5E3', 'the bit in S5E3 where she stays'],
    ['s5 e3', 'the closing scene of s5 e3'],
    ['season 5 episode 3', 'season 5 episode 3, the airport bit'],
    ['season 5, ep 3', 'season 5, ep 3 is the one'],
    ['5x03', 'the 5x03 ending'],
  ])('reads season and episode written as %s', (_form, line) => {
    expect(read(line).where?.videoIds).toEqual(['v6'])
  })

  it.each([
    ['S5', 'The Marnie/Charlie bottle episode in S5 is my favourite'],
    ['season 5', 'the scenes in season 5 where she stays'],
    ['season five', 'somewhere in season five'],
  ])('reads a season on its own from %s', (_form, line) => {
    const request = read(line)

    expect(request.where?.label).toBe('season 5')
    expect(request.where?.videoIds).toEqual(['v6', 'v7', 'v8', 'v9'])
  })

  /*
   * "s" has to hug its digits. `\b` matches after an apostrophe, so allowing "s 5"
   * turns every contraction followed by a number into a season marker.
   */
  it('does not read a contraction before a number as a season', () => {
    expect(read("it's 5 minutes in when the vase goes over").where).toBeNull()
  })

  it('resolves a season finale to that season’s last episode', () => {
    const request = read('The S5 finale when Hannah reads at The Moth')

    expect(request.where?.videoIds).toEqual(['v9'])
    expect(request.where?.label).toBe('I Love You Baby (S5E10)')
  })

  it('resolves a season premiere to that season’s first episode', () => {
    expect(read('the season 6 premiere').where?.videoIds).toEqual(['v10'])
  })

  /*
   * "Should've been the series finale" is a counterfactual about a scene elsewhere.
   * Resolving a bare finale against the whole run would send it to the wrong episode.
   */
  it('ignores a finale with no season attached', () => {
    expect(read('should have been the series finale honestly').where).toBeNull()
  })

  it.each([
    ['quoted', '“Hello Kitty” which I think is s5 e3', 'v8'],
    ['unquoted', 'the ending scene to Beach House which I think is s5 e3', 'v5'],
  ])('prefers a %s episode title over contradicting numbers', (_form, line, videoId) => {
    // Someone who remembers the title is likelier right than someone counting.
    expect(read(line).where?.videoIds).toEqual([videoId])
  })

  it.each([
    ['cold open', 'the cold open where he walks in'],
    ['opening scene', 'the opening scene of the party'],
    ['opens with', 'the episode opens with her on the roof'],
  ])('reads %s as the start of an episode', (_form, line) => {
    expect(read(line).when).toBe('opening')
  })

  it.each([
    ['closing scene', 'the closing scene of the party'],
    ['the ending', 'the ending where she leaves Desi'],
    ['ending scene', 'The ending scene to the party'],
    ['credits scene', 'The credits scene at the end'],
    ['at the end', 'sitting in the diner at the end when they realise'],
    ['final scene', 'the final scene on the beach'],
  ])('reads %s as the end of an episode', (_form, line) => {
    expect(read(line).when).toBe('ending')
  })

  /*
   * A measured false positive: "ending" on its own describes an arc, not a position.
   */
  it('does not read a happy ending as the end of an episode', () => {
    expect(read('rays happy ending in meeting Abigail was a great payoff').when).toBeNull()
  })

  it('gives no position when a line claims both ends', () => {
    expect(read('it opens with the fight and the final scene is the diner').when).toBeNull()
  })

  it('leaves a description with no location in it completely alone', () => {
    const line = 'Natalia ( and Amy Schumer) confronting Adam at the coffee shop'
    expect(read(line)).toEqual({ text: line, where: null, when: null })
  })

  it('finds no location when the show has no episode list', () => {
    const line = 'the ending scene to Beach House'
    expect(readSceneRequest(line, []).where).toBeNull()
    // Position needs no episode list, so it survives.
    expect(readSceneRequest(line, []).when).toBe('ending')
  })

  it('does not mistake an apostrophe for a quote mark', () => {
    // Were ' a span delimiter, "s got it, it" would be tested against the episode list.
    const line = "He's got it, it's the diner scene"
    expect(read(line).text).toBe(line)
  })
})

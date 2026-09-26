import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitSceneDescriptions } from './split'

describe('splitSceneDescriptions', () => {
  it('splits a numbered list', () => {
    const input = `
1. The scene where he declares bankruptcy in the middle of the office
2) When she tells him the truth about the merger
3. Anything with the fire drill
    `
    expect(splitSceneDescriptions(input)).toEqual([
      'The scene where he declares bankruptcy in the middle of the office',
      'When she tells him the truth about the merger',
      'Anything with the fire drill',
    ])
  })

  it('strips bullets, blockquotes and nested markers', () => {
    const input = [
      '- the dinner party where everything goes wrong',
      '> * 2. when they get locked out of the building',
      '• The one with the tiny stapler in jello',
    ].join('\n')
    expect(splitSceneDescriptions(input)).toEqual([
      'the dinner party where everything goes wrong',
      'when they get locked out of the building',
      'The one with the tiny stapler in jello',
    ])
  })

  it('removes reddit handles, markdown and edit suffixes', () => {
    const input =
      '**The fire drill scene** is peak comedy, /u/someuser said it best. Edit: thanks for the gold'
    expect(splitSceneDescriptions(input)).toEqual([
      'The fire drill scene is peak comedy, said it best.',
    ])
  })

  it('drops low-content noise lines', () => {
    const input = [
      'lol',
      'same',
      '[deleted]',
      '4.2k points',
      'Scrolled too far for this',
      'The scene where the cat knocks the vase off the shelf',
    ].join('\n')
    expect(splitSceneDescriptions(input)).toEqual([
      'The scene where the cat knocks the vase off the shelf',
    ])
  })

  it('splits a run-on paragraph into sentences', () => {
    const input =
      'The fire drill scene is the best one by far and I rewatch it constantly. ' +
      'I also love when he tries to grill his foot on the george foreman. ' +
      'The dinner party episode is the most uncomfortable television ever made.'
    const result = splitSceneDescriptions(input)
    expect(result).toHaveLength(3)
    expect(result[1]).toContain('george foreman')
  })

  it('keeps a short single description intact rather than splitting it', () => {
    const input = 'The fire drill scene. It is great.'
    expect(splitSceneDescriptions(input)).toEqual(['The fire drill scene. It is great.'])
  })

  it('deduplicates case and punctuation variants', () => {
    const input = ['The fire drill scene!', 'the fire drill scene', 'The Fire Drill Scene.'].join(
      '\n',
    )
    expect(splitSceneDescriptions(input)).toEqual(['The fire drill scene!'])
  })

  it('unwraps fully quoted lines', () => {
    expect(splitSceneDescriptions('"the one where they steal the boat"')).toEqual([
      'the one where they steal the boat',
    ])
  })

  it('unwraps single quotes too, when they wrap the whole line', () => {
    expect(splitSceneDescriptions("'the one where they steal the boat'")).toEqual([
      'the one where they steal the boat',
    ])
  })

  it('does not mistake apostrophes for quote marks', () => {
    // Two apostrophes in one line. Treated as a quoted span the result would be
    // "s got it, it" — which is why the span pattern matches double quotes only.
    expect(splitSceneDescriptions("He's got it, it's completely fine")).toEqual([
      "He's got it, it's completely fine",
    ])
  })

  it('keeps an apostrophe that sits inside a quoted span', () => {
    // The apostrophe must not end the span either: were it a delimiter this would
    // come back as "we can" plus a fragment.
    expect(splitSceneDescriptions('She says "we can\'t stay here" and leaves')).toEqual([
      "we can't stay here",
    ])
  })

  it.each([
    ['before', 'I quote this constantly: "we were on a break"'],
    ['after', '"we were on a break" and I say it every single week'],
  ])('takes the quote and drops commentary sitting %s it', (_side, input) => {
    expect(splitSceneDescriptions(input)).toEqual(['we were on a break'])
  })

  it.each([
    ['1 more reply'],
    ['7 more replies'],
    ['Thumbnail image: Shifts that fit around your schedule'],
    ['Funniest and most quoted by me:'],
  ])('drops reddit furniture that reads like an answer: %s', (junk) => {
    const real = 'The scene where the cat knocks the vase off the shelf'
    expect(splitSceneDescriptions([junk, real].join('\n'))).toEqual([real])
  })

  it('keeps a colon that sits mid-line, because only a trailing one is a preamble', () => {
    const input = 'Also: the one where he turns himself into a pickle'
    expect(splitSceneDescriptions(input)).toEqual([input])
  })

  /*
   * A promoted post's copy is ordinary English, so it can only be found by its
   * position between Reddit's `Ad` marker and the alt text that closes the block.
   */
  it('drops a promoted post whole, copy and call to action alike', () => {
    const input = [
      'u/advertiser_02 avatar',
      'u/advertiser_02',
      '•',
      'Ad',
      '',
      'Shifts that fit around your schedule',
      'Learn More',
      'advertiser-two.example',
      'Thumbnail image: Shifts that fit around your schedule',
      'The one where they steal the boat and sink it',
    ].join('\n')
    expect(splitSceneDescriptions(input)).toEqual(['The one where they steal the boat and sink it'])
  })

  /*
   * The failure worth guarding: a marker with no closing line must not swallow the
   * thread behind it. Better one stray line than fifteen lost answers.
   */
  it('leaves an unclosed ad marker alone rather than eating the answers after it', () => {
    const answers = Array.from(
      { length: 4 },
      (_, i) => `The scene in episode ${i} where the vase goes off the shelf`,
    )
    expect(splitSceneDescriptions(['Ad', ...answers].join('\n'))).toEqual(answers)
  })

  it('returns nothing for empty or whitespace input', () => {
    expect(splitSceneDescriptions('')).toEqual([])
    expect(splitSceneDescriptions('   \n\n  ')).toEqual([])
  })

  it('respects the maximum description count', () => {
    const input = Array.from({ length: 100 }, (_, i) => `Scene number ${i} where something happens`)
    expect(splitSceneDescriptions(input.join('\n'), { maxDescriptions: 10 })).toHaveLength(10)
  })
})

/*
 * Copying a comment section is the way people actually feed this thing, so these
 * run against reddit-thread.fixture.txt: a real thread's exact layout with every
 * comment rewritten. Author names are `user_NN` placeholders of the same shape — a
 * single token, which is what the furniture rules key on — and the comment text is
 * invented, so no one's words are republished here.
 *
 * The furniture — usernames, `•`, "3y ago", vote counts, [deleted] — was already
 * handled. What was not: the quote is usually welded to commentary about it, and
 * the commentary matches no dialogue, so a clip built from the whole line finds
 * the wrong scene or nothing at all.
 */
describe('splitSceneDescriptions on a real reddit thread', () => {
  const thread = readFileSync(join(import.meta.dirname, 'reddit-thread.fixture.txt'), 'utf8')
  const descriptions = splitSceneDescriptions(thread)

  it('keeps only the comment bodies, not reddit’s furniture', () => {
    expect(descriptions).toHaveLength(7)
    for (const description of descriptions) {
      expect(description).not.toMatch(/\bago\b|\[deleted\]|user_\d+|^\d+$|•/)
    }
  })

  it('extracts a quote and drops the verdict welded to it', () => {
    expect(descriptions).toContain('Sorry, I only row in one direction.')
    expect(descriptions.join('\n')).not.toContain('Iconic')
  })

  it('splits a line quoting two things into two descriptions', () => {
    expect(descriptions).toContain('Hold the liiiine')
    expect(descriptions).toContain('hold thaaat liiiiiiine')
  })

  it('leaves a line with no quote in it whole', () => {
    expect(descriptions).toContain('YOU SOLD MY BOAT!')
    expect(descriptions).toContain('Is this the whole plan? Is this the punishment?')
  })

  it('keeps a long quote whole rather than splitting it on its full stops', () => {
    const cells = descriptions.find((d) => d.startsWith('Tides return'))
    expect(cells).toContain('leaving is right')
    expect(cells).toContain('it means Drowning')
  })

  /*
   * The one this cannot fix, and the reason the user reviews the list: a comment
   * with no quote in it is indistinguishable from a description written in prose.
   * "the one where he turns himself into a pickle" is legitimate; this is not.
   */
  it('cannot tell pure commentary from a prose description, so it keeps it', () => {
    expect(descriptions).toContain('Honestly the slowest build to a punchline the show ever did.')
  })
})

/*
 * A second thread, girls-thread.fixture.txt, kept because it carries furniture the
 * first does not: two promoted posts and six "N more replies" buttons. As above,
 * the layout is real and everything written in it — names, comments, the
 * advertisers' copy and domains — is invented; the *shape* is what the rules read.
 *
 * Junk here is not free. Each entry costs an embedding and a vector search on paste,
 * and then two Jellyfin transcodes the moment the editor opens it.
 */
describe('splitSceneDescriptions on a thread carrying ads and reply buttons', () => {
  const thread = readFileSync(join(import.meta.dirname, 'girls-thread.fixture.txt'), 'utf8')
  const descriptions = splitSceneDescriptions(thread)

  it('keeps every answer and nothing else', () => {
    expect(descriptions).toHaveLength(21)
  })

  it.each([
    ['reply buttons', /more repl(y|ies)/i],
    ['promoted copy', /hidden mark|around your schedule/i],
    ['thumbnail alt text', /thumbnail image/i],
    ['a preamble introducing the next line', /quoted by me/i],
    ['usernames, timestamps and vote counts', /\bavatar\b|\d+y ago|^\d+$|•/],
  ])('drops %s', (_kind, junk) => {
    for (const description of descriptions) {
      expect(description).not.toMatch(junk)
    }
  })

  it('keeps the answers that sit either side of a promoted post', () => {
    // The block between them closes with alt text repeating its own copy, so
    // over-reaching by one line in either direction would take a real answer.
    expect(descriptions).toContain('Mira ( and her sister) confronting Theo at the bakery')
    expect(descriptions.some((d) => d.startsWith('For me, its gotta be the scenes in season 3'))).toBe(
      true,
    )
  })
})

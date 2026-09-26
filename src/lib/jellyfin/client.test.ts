import { describe, expect, it } from 'vitest'
import { collapseSplitTitles, JellyfinClient } from './client'
import type { BaseItem, MediaSource } from './types'

const series = (Id: string, ProviderIds: Record<string, string> | null): BaseItem => ({
  Id,
  Name: 'Rick and Morty',
  Type: 'Series',
  ProviderIds,
})

describe('collapseSplitTitles', () => {
  it('keeps one entry for a show split across library folders', () => {
    const items = [series('b2', { Tvdb: '275274' }), series('1e', { Tvdb: '275274' })]
    expect(collapseSplitTitles(items).map((i) => i.Id)).toEqual(['1e'])
  })

  it('leaves titles with different or missing ids alone', () => {
    const items = [series('a', { Tvdb: '1' }), series('b', { Tvdb: '2' }), series('c', null), series('d', null)]
    expect(collapseSplitTitles(items)).toHaveLength(4)
  })

  it('does not merge a film with a show that shares an id', () => {
    const film: BaseItem = { ...series('f', { Imdb: 'tt1' }), Type: 'Movie' }
    expect(collapseSplitTitles([series('s', { Imdb: 'tt1' }), film])).toHaveLength(2)
  })
})

describe('pickSubtitleTrack', () => {
  const source = (...langs: (string | null)[]): MediaSource[] => [
    {
      Id: 'm',
      Path: null,
      Container: 'mkv',
      MediaStreams: langs.map((Language, Index) => ({
        Index,
        Type: 'Subtitle',
        Codec: 'subrip',
        Language,
        DisplayTitle: null,
        IsDefault: false,
        IsForced: false,
        IsExternal: false,
        IsTextSubtitleStream: true,
      })),
    },
  ]

  it('prefers English', () => {
    expect(JellyfinClient.pickSubtitleTrack(source('rus', 'eng'))?.language).toBe('eng')
  })

  it('never falls back to another language', () => {
    expect(JellyfinClient.pickSubtitleTrack(source('rus'))).toBeNull()
  })

  it('keeps untagged tracks', () => {
    expect(JellyfinClient.pickSubtitleTrack(source(null))).not.toBeNull()
    expect(JellyfinClient.pickSubtitleTrack(source('und'))).not.toBeNull()
  })
})

describe('pickAudioStream', () => {
  const audio = (...langs: (string | null)[]): MediaSource[] => [
    {
      Id: 'm',
      Path: null,
      Container: 'mkv',
      MediaStreams: langs.map((Language, i) => ({
        Index: i + 1,
        Type: 'Audio',
        Codec: 'ac3',
        Language,
        DisplayTitle: null,
        IsDefault: i === 0,
        IsForced: false,
        IsExternal: false,
        IsTextSubtitleStream: false,
      })),
    },
  ]

  it('takes the English track when a dub comes first', () => {
    expect(JellyfinClient.pickAudioStream(audio('rus', 'eng'))).toBe(2)
  })

  it('leaves the default alone when there is no English track', () => {
    expect(JellyfinClient.pickAudioStream(audio('rus'))).toBeNull()
  })
})

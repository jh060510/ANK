import { describe, expect, it } from 'vitest'

import { liveActivityLength, ownsLiveSession, safeDiarizationSpeaker } from './liveSession'

describe('live session ownership', () => {
  const stream = {}
  const socket = {}
  const owner = { session: 4, connection: 7, stream, socket }

  it('accepts only the current session resources', () => {
    expect(ownsLiveSession(owner, {
      session: 4,
      connection: 7,
      stream,
      socket,
    })).toBe(true)
  })

  it('rejects a late callback after a new start even if objects are reused', () => {
    expect(ownsLiveSession(owner, {
      session: 5,
      connection: 7,
      stream,
      socket,
    })).toBe(false)
  })

  it('rejects callbacks from the socket replaced by reconnect', () => {
    expect(ownsLiveSession(owner, {
      session: 4,
      connection: 8,
      stream,
      socket: {},
    })).toBe(false)
  })

  it('supports startup checks before a connection or socket exists', () => {
    expect(ownsLiveSession(
      { session: 4, stream },
      { session: 4, stream },
    )).toBe(true)
  })

  it('clears a retracted interim and bounds visible activity', () => {
    expect(liveActivityLength('')).toBeNull()
    expect(liveActivityLength('hi')).toBe(18)
    expect(liveActivityLength('x'.repeat(120))).toBe(100)
  })

  it('drops connection-local speaker numbers after a reconnect', () => {
    expect(safeDiarizationSpeaker(0, true)).toBe(0)
    expect(safeDiarizationSpeaker(0, false)).toBeUndefined()
  })
})

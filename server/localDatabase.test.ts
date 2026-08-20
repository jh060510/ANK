import { afterEach, describe, expect, it } from 'vitest'

import { LocalWorkspaceDatabase } from './localDatabase'

const openDatabases: LocalWorkspaceDatabase[] = []

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()?.close()
})

describe('local workspace database', () => {
  it('persists and atomically replaces the single workspace snapshot', () => {
    const database = new LocalWorkspaceDatabase(':memory:')
    openDatabases.push(database)
    expect(database.read()).toBeNull()

    const first = { schemaVersion: 2, activeContextId: 'a', contexts: [{ id: 'a' }] }
    database.write(first, 100)
    expect(database.read()).toEqual({ workspace: first, savedAt: 100 })

    const second = { schemaVersion: 2, activeContextId: 'b', contexts: [{ id: 'b' }] }
    database.write(second, 200)
    expect(database.read()).toEqual({ workspace: second, savedAt: 200 })
  })

  it('archives a rich snapshot before a destructive replacement', () => {
    const database = new LocalWorkspaceDatabase(':memory:')
    openDatabases.push(database)
    const interview = {
      schemaVersion: 2,
      activeContextId: 'interview',
      contexts: [{
        id: 'interview',
        segments: [{ id: 'speech' }],
        preparedQuestions: [{ id: 'question' }],
      }],
    }
    database.write(interview, 100)
    database.write({
      schemaVersion: 2,
      activeContextId: 'empty',
      contexts: [{ id: 'empty', segments: [], preparedQuestions: [] }],
    }, 200)
    expect(database.readHistory()).toEqual([{ workspace: interview, savedAt: 100 }])
  })
})

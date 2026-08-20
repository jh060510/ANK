import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type StoredWorkspaceSnapshot = {
  workspace: unknown
  savedAt: number
}

type WorkspaceRow = {
  payload: string
  saved_at: number
}

type WorkspaceShape = {
  contextIds: Set<string>
  segmentCount: number
  preparedQuestionCount: number
}

const HISTORY_INTERVAL_MS = 5 * 60_000

function workspaceShape(workspace: unknown): WorkspaceShape {
  const shape: WorkspaceShape = {
    contextIds: new Set(),
    segmentCount: 0,
    preparedQuestionCount: 0,
  }
  if (!workspace || typeof workspace !== 'object') return shape
  const contexts = (workspace as { contexts?: unknown }).contexts
  if (!Array.isArray(contexts)) return shape
  for (const value of contexts) {
    if (!value || typeof value !== 'object') continue
    const context = value as {
      id?: unknown
      segments?: unknown
      preparedQuestions?: unknown
    }
    if (typeof context.id === 'string') shape.contextIds.add(context.id)
    if (Array.isArray(context.segments)) shape.segmentCount += context.segments.length
    if (Array.isArray(context.preparedQuestions)) {
      shape.preparedQuestionCount += context.preparedQuestions.length
    }
  }
  return shape
}

function isDestructiveReplacement(previous: unknown, next: unknown): boolean {
  const before = workspaceShape(previous)
  const after = workspaceShape(next)
  return (
    [...before.contextIds].some((id) => !after.contextIds.has(id))
    || after.segmentCount < before.segmentCount
    || after.preparedQuestionCount < before.preparedQuestionCount
  )
}

export class LocalWorkspaceDatabase {
  private readonly database: DatabaseSync

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true })
    this.database = new DatabaseSync(filename)
    this.database.exec('PRAGMA journal_mode = WAL')
    this.database.exec('PRAGMA synchronous = NORMAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      )
    `)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_snapshot_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        saved_at INTEGER NOT NULL UNIQUE,
        archived_at INTEGER NOT NULL,
        reason TEXT NOT NULL
      )
    `)
  }

  read(): StoredWorkspaceSnapshot | null {
    const row = this.database.prepare(
      'SELECT payload, saved_at FROM workspace_snapshots WHERE id = 1',
    ).get() as WorkspaceRow | undefined
    if (!row) return null
    try {
      return { workspace: JSON.parse(row.payload) as unknown, savedAt: row.saved_at }
    } catch {
      return null
    }
  }

  write(workspace: unknown, savedAt = Date.now()): StoredWorkspaceSnapshot {
    const payload = JSON.stringify(workspace)
    const current = this.read()
    const lastHistory = this.database.prepare(
      'SELECT saved_at FROM workspace_snapshot_history ORDER BY id DESC LIMIT 1',
    ).get() as { saved_at: number } | undefined
    const destructive = current
      ? isDestructiveReplacement(current.workspace, workspace)
      : false
    const periodic = current
      ? !lastHistory || current.savedAt - lastHistory.saved_at >= HISTORY_INTERVAL_MS
      : false
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (current && (destructive || periodic)) {
        this.database.prepare(`
          INSERT OR IGNORE INTO workspace_snapshot_history
            (schema_version, payload, saved_at, archived_at, reason)
          VALUES (2, ?, ?, ?, ?)
        `).run(
          JSON.stringify(current.workspace),
          current.savedAt,
          Date.now(),
          destructive ? 'destructive-replacement' : 'periodic',
        )
      }
      this.database.prepare(`
        INSERT INTO workspace_snapshots (id, schema_version, payload, saved_at)
        VALUES (1, 2, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          schema_version = excluded.schema_version,
          payload = excluded.payload,
          saved_at = excluded.saved_at
      `).run(payload, savedAt)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return { workspace, savedAt }
  }

  readHistory(limit = 20): StoredWorkspaceSnapshot[] {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200))
    const rows = this.database.prepare(`
      SELECT payload, saved_at
      FROM workspace_snapshot_history
      ORDER BY id DESC
      LIMIT ?
    `).all(safeLimit) as WorkspaceRow[]
    return rows.flatMap((row) => {
      try {
        return [{ workspace: JSON.parse(row.payload) as unknown, savedAt: row.saved_at }]
      } catch {
        return []
      }
    })
  }

  close(): void {
    this.database.close()
  }
}

// Decides which Claude Code session a run may resume and which session a run
// produced. Filesystem only, so it is testable against a temp ~/.claude.
const fs = require('fs')
const path = require('path')

const KEY_PREFIX = 'claude-session'
const SEPARATOR = '--'
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Marker Claude Code writes after replaying the notifications of subagents a dead process left running */
const ORPHANED = 'Orphaned by a previous Claude Code process exit'

/** Tool names that launch subagents */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/**
 * @typedef {object} Resolution
 * @property {string} id      session id to resume, empty to start fresh
 * @property {string} args    "--resume <id>" or empty
 * @property {string} reason  why the run starts fresh, empty when resuming
 */

/**
 * Keep [A-Za-z0-9_.] and collapse every other run of characters to one "-",
 * so no slug contains the "--" separator and one scope cannot prefix-match another.
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
  return String(value).replace(/[^A-Za-z0-9_.]+/g, '-')
}

/**
 * Cache entries are immutable, so each run saves under its own key and restores
 * the newest entry by the (scope, workflow) prefix.
 * @param {{ scope: string, workflow: string, runId: string, runAttempt: string }} opts
 * @returns {{ prefix: string, save: string }}
 */
function cacheKeys({ scope, workflow, runId, runAttempt }) {
  if (!String(scope || '').trim()) {
    throw new Error('scope is required (for example pr-12 or issue-34)')
  }
  const prefix = [KEY_PREFIX, slug(scope.trim()), slug(workflow)].join(SEPARATOR) + SEPARATOR
  return { prefix, save: `${prefix}${runId}-${runAttempt}` }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isSessionId(value) {
  return SESSION_ID.test(String(value || '').trim())
}

/**
 * @param {string} file
 * @returns {string} trimmed contents, empty when unreadable
 */
function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (_err) {
    return ''
  }
}

/**
 * Top-level conversation transcripts. Subagent transcripts live one level down
 * in <session-id>/subagents/, so they are excluded by construction.
 * @param {string} claudeHome
 * @returns {{ id: string, file: string }[]}
 */
function transcripts(claudeHome) {
  const projects = path.join(claudeHome, 'projects')
  let dirs = []
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (_err) {
    return []
  }
  return dirs.flatMap((dir) => {
    const project = path.join(projects, dir.name)
    return fs.readdirSync(project, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl') && isSessionId(f.name.slice(0, -6)))
      .map((f) => ({ id: f.name.slice(0, -6), file: path.join(project, f.name) }))
  })
}

/**
 * Why a transcript must not be resumed, or null when it may be. A session
 * killed with subagents running comes back with orphaned notifications queued,
 * and resuming it spends the run replaying them instead of reading the prompt.
 * @param {string} text  jsonl transcript
 * @returns {string|null}
 */
function transcriptProblem(text) {
  if (text.includes(ORPHANED)) {
    return 'the transcript already replayed orphaned background tasks'
  }
  const started = new Set()
  const finished = new Set()
  let parsed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch (_err) {
      // A half-written last line is what a killed run leaves behind
      continue
    }
    parsed++
    const content = entry && entry.message && entry.message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part && part.type === 'tool_use' && SUBAGENT_TOOLS.has(part.name) && part.id) {
        started.add(part.id)
      }
      if (part && part.type === 'tool_result' && part.tool_use_id) {
        finished.add(part.tool_use_id)
      }
    }
  }
  if (parsed === 0) {
    return 'the transcript could not be parsed'
  }
  const unresolved = [...started].filter((id) => !finished.has(id))
  if (unresolved.length) {
    return `the transcript has ${unresolved.length} unresolved subagent call(s)`
  }
  return null
}

/**
 * Only the session an earlier run recorded for this scope is resumable, never
 * "the newest transcript on disk". Every failed check starts fresh.
 * @param {{ claudeHome: string, scope: string }} opts
 * @returns {Resolution}
 */
function resolveSession({ claudeHome, scope }) {
  /** @param {string} reason */
  const fresh = (reason) => ({ id: '', args: '', reason })
  const meta = path.join(claudeHome, 'session-meta')
  const recordedId = readTrimmed(path.join(meta, 'session-id'))
  const recordedScope = readTrimmed(path.join(meta, 'scope'))

  if (!recordedId) return fresh('no session id was recorded')
  if (!isSessionId(recordedId)) return fresh('the recorded session id is not a session id')
  if (recordedScope !== scope) return fresh(`the recorded session belongs to ${recordedScope || 'no scope'}, not ${scope}`)

  const match = transcripts(claudeHome).find((t) => t.id === recordedId)
  if (!match) return fresh(`the transcript for ${recordedId} was not restored`)
  const problem = transcriptProblem(readTrimmed(match.file))
  if (problem) return fresh(problem)

  return { id: recordedId, args: `--resume ${recordedId}`, reason: '' }
}

/**
 * The session this run produced: the newest transcript modified since the run
 * started. Restored transcripts keep their original mtimes, so they are skipped.
 * @param {{ claudeHome: string, startedAtMs: number }} opts
 * @returns {string} session id, empty when none
 */
function latestSessionId({ claudeHome, startedAtMs }) {
  let latest = { id: '', mtimeMs: -1 }
  for (const t of transcripts(claudeHome)) {
    const { mtimeMs } = fs.statSync(t.file)
    if (mtimeMs >= startedAtMs && mtimeMs > latest.mtimeMs) {
      latest = { id: t.id, mtimeMs }
    }
  }
  return latest.id
}

/**
 * Record which session and scope a cache entry holds, so the next restore
 * resumes an id this run vouched for.
 * @param {{ claudeHome: string, id: string, scope: string }} opts
 */
function recordSession({ claudeHome, id, scope }) {
  const meta = path.join(claudeHome, 'session-meta')
  fs.mkdirSync(meta, { recursive: true })
  fs.writeFileSync(path.join(meta, 'session-id'), `${id}\n`)
  fs.writeFileSync(path.join(meta, 'scope'), `${scope}\n`)
}

module.exports = {
  slug,
  cacheKeys,
  isSessionId,
  transcriptProblem,
  resolveSession,
  latestSessionId,
  recordSession,
}

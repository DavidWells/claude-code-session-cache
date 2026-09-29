// Save action script: finds the session this run wrote, records it in
// session-meta, and tells the cache save step whether to run.
const os = require('os')
const path = require('path')
const { latestSessionId, recordSession } = require('./session')
const { setOutput } = require('./github')

const claudeHome = path.join(os.homedir(), '.claude')

function save() {
  const scope = process.env.CLAUDE_SESSION_CACHE_SCOPE || ''
  const key = process.env.CLAUDE_SESSION_CACHE_KEY || ''
  if (!scope || !key) {
    console.log('The restore step did not run; nothing to save.')
    setOutput('save', 'false')
    return
  }
  const startedAtMs = Number(process.env.CLAUDE_SESSION_CACHE_STARTED_AT || 0)
  const id = latestSessionId({ claudeHome, startedAtMs })
  if (!id) {
    console.log(`No Claude session was written for ${scope}; nothing to save.`)
    setOutput('save', 'false')
    return
  }
  recordSession({ claudeHome, id, scope })
  console.log(`Saving session ${id} for ${scope} as ${key}.`)
  setOutput('save', 'true')
  setOutput('session-id', id)
}

try {
  save()
} catch (err) {
  // Losing a save is not worth failing a job that otherwise finished
  console.log('::warning::claude-code-session-cache', err instanceof Error ? err.message : err)
  setOutput('save', 'false')
}

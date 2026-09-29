// Restore action scripts: "keys" computes cache keys before the cache restore,
// "resolve" decides after it whether Claude should resume a session.
const os = require('os')
const path = require('path')
const { cacheKeys, resolveSession } = require('./session')
const { setOutput, exportVariable } = require('./github')

const claudeHome = path.join(os.homedir(), '.claude')

function keys() {
  const scope = (process.env.INPUT_SCOPE || '').trim()
  const { prefix, save } = cacheKeys({
    scope,
    workflow: process.env.GITHUB_WORKFLOW || '',
    runId: process.env.GITHUB_RUN_ID || '0',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  })
  setOutput('key', save)
  setOutput('restore-prefix', prefix)
  // Handed to the save action so the two halves cannot disagree on scope/key
  exportVariable('CLAUDE_SESSION_CACHE_SCOPE', scope)
  exportVariable('CLAUDE_SESSION_CACHE_KEY', save)
  exportVariable('CLAUDE_SESSION_CACHE_STARTED_AT', String(Date.now()))
}

function resolve() {
  const scope = process.env.CLAUDE_SESSION_CACHE_SCOPE || ''
  const { id, args, reason } = resolveSession({ claudeHome, scope })
  if (id) {
    console.log(`Resuming Claude session ${id} for ${scope}.`)
  } else {
    console.log(`No session to resume (${reason}); Claude will start fresh.`)
  }
  setOutput('session-id', id)
  setOutput('resume-args', args)
  setOutput('resumed', id ? 'true' : 'false')
}

const commands = { keys, resolve }
const command = process.argv[2]

try {
  if (!(command in commands)) throw new Error(`usage: restore.js <${Object.keys(commands).join('|')}>`)
  commands[/** @type {'keys'|'resolve'} */ (command)]()
} catch (err) {
  console.error('claude-code-session-cache', err instanceof Error ? err.message : err)
  process.exit(1)
}

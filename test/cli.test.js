// End-to-end tests of the restore/save scripts as the composite actions run
// them: real processes, a temp HOME, and real GITHUB_OUTPUT/GITHUB_ENV files.
const { test } = require('uvu')
const assert = require('uvu/assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

/**
 * Parse a GITHUB_OUTPUT/GITHUB_ENV file (name=value and heredoc forms).
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readCommandFile(file) {
  /** @type {Record<string, string>} */
  const out = {}
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^=]+)<<(.+)$/)
    if (heredoc) {
      const body = []
      i++
      while (lines[i] !== heredoc[2]) body.push(lines[i++])
      out[heredoc[1]] = body.join('\n')
    } else if (lines[i].includes('=')) {
      const idx = lines[i].indexOf('=')
      out[lines[i].slice(0, idx)] = lines[i].slice(idx + 1)
    }
  }
  return out
}

/** @returns {{ home: string, claudeHome: string, output: string, env: string }} */
function runnerSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsc-cli-'))
  const output = path.join(home, 'github_output')
  const env = path.join(home, 'github_env')
  fs.writeFileSync(output, '')
  fs.writeFileSync(env, '')
  return { home, claudeHome: path.join(home, '.claude'), output, env }
}

/**
 * @param {string} script
 * @param {string[]} args
 * @param {ReturnType<typeof runnerSandbox>} box
 * @param {Record<string, string>} extraEnv
 */
function run(script, args, box, extraEnv) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'src', script), ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: box.home,
      GITHUB_OUTPUT: box.output,
      GITHUB_ENV: box.env,
      GITHUB_WORKFLOW: 'Claude Code',
      GITHUB_RUN_ID: '500',
      GITHUB_RUN_ATTEMPT: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  })
  return result
}

/**
 * @param {string} claudeHome
 * @param {string} id
 */
function writeTranscript(claudeHome, id) {
  const dir = path.join(claudeHome, 'projects', '-home-runner-work-repo-repo')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
  return file
}

test('restore keys: outputs cache keys and exports state for save', () => {
  const box = runnerSandbox()
  const result = run('restore.js', ['keys'], box, { INPUT_SCOPE: 'pr-12' })
  assert.is(result.status, 0, result.stderr)
  const outputs = readCommandFile(box.output)
  assert.is(outputs.key, 'claude-session--pr-12--Claude-Code--500-1')
  assert.is(outputs['restore-prefix'], 'claude-session--pr-12--Claude-Code--')
  const env = readCommandFile(box.env)
  assert.is(env.CLAUDE_SESSION_CACHE_SCOPE, 'pr-12')
  assert.is(env.CLAUDE_SESSION_CACHE_KEY, 'claude-session--pr-12--Claude-Code--500-1')
  assert.ok(Number(env.CLAUDE_SESSION_CACHE_STARTED_AT) > 0)
})

test('restore keys: fails without a scope', () => {
  const box = runnerSandbox()
  const result = run('restore.js', ['keys'], box, { INPUT_SCOPE: '' })
  assert.is(result.status, 1)
  assert.match(result.stderr, /scope is required/)
})

test('restore resolve: outputs resume args for a recorded session', () => {
  const box = runnerSandbox()
  writeTranscript(box.claudeHome, ID_A)
  fs.mkdirSync(path.join(box.claudeHome, 'session-meta'), { recursive: true })
  fs.writeFileSync(path.join(box.claudeHome, 'session-meta', 'session-id'), `${ID_A}\n`)
  fs.writeFileSync(path.join(box.claudeHome, 'session-meta', 'scope'), 'pr-12\n')
  const result = run('restore.js', ['resolve'], box, { CLAUDE_SESSION_CACHE_SCOPE: 'pr-12' })
  assert.is(result.status, 0, result.stderr)
  assert.match(result.stdout, `Resuming Claude session ${ID_A} for pr-12`)
  assert.equal(readCommandFile(box.output), { 'session-id': ID_A, 'resume-args': `--resume ${ID_A}`, resumed: 'true' })
})

test('restore resolve: starts fresh and says why', () => {
  const box = runnerSandbox()
  const result = run('restore.js', ['resolve'], box, { CLAUDE_SESSION_CACHE_SCOPE: 'pr-12' })
  assert.is(result.status, 0, result.stderr)
  assert.match(result.stdout, 'No session to resume (no session id was recorded)')
  assert.equal(readCommandFile(box.output), { 'session-id': '', 'resume-args': '', resumed: 'false' })
})

test('save: records the session this run wrote and asks for a cache save', () => {
  const box = runnerSandbox()
  const restored = writeTranscript(box.claudeHome, ID_A)
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(restored, past, past)
  const startedAt = String(Date.now() - 1000)
  writeTranscript(box.claudeHome, ID_B)
  const result = run('save.js', [], box, {
    CLAUDE_SESSION_CACHE_SCOPE: 'pr-12',
    CLAUDE_SESSION_CACHE_KEY: 'claude-session--pr-12--Claude-Code--500-1',
    CLAUDE_SESSION_CACHE_STARTED_AT: startedAt,
  })
  assert.is(result.status, 0, result.stderr)
  assert.equal(readCommandFile(box.output), { save: 'true', 'session-id': ID_B })
  assert.is(fs.readFileSync(path.join(box.claudeHome, 'session-meta', 'session-id'), 'utf8'), `${ID_B}\n`)
  assert.is(fs.readFileSync(path.join(box.claudeHome, 'session-meta', 'scope'), 'utf8'), 'pr-12\n')
})

test('save: nothing to save when no transcript was written this run', () => {
  const box = runnerSandbox()
  const result = run('save.js', [], box, {
    CLAUDE_SESSION_CACHE_SCOPE: 'pr-12',
    CLAUDE_SESSION_CACHE_KEY: 'k',
    CLAUDE_SESSION_CACHE_STARTED_AT: String(Date.now()),
  })
  assert.is(result.status, 0, result.stderr)
  assert.match(result.stdout, 'No Claude session was written for pr-12; nothing to save.')
  assert.equal(readCommandFile(box.output), { save: 'false' })
})

test('save: skips quietly when restore never ran', () => {
  const box = runnerSandbox()
  const result = run('save.js', [], box, {})
  assert.is(result.status, 0, result.stderr)
  assert.match(result.stdout, 'restore step did not run')
  assert.equal(readCommandFile(box.output), { save: 'false' })
})

test.run()

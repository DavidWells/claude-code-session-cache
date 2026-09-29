// Tests for session resolution: cache keys, transcript safety checks, which
// session to resume and which session a run produced.
const { test } = require('uvu')
const assert = require('uvu/assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  slug,
  cacheKeys,
  transcriptProblem,
  resolveSession,
  latestSessionId,
  recordSession,
} = require('../src/session')

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

/** @returns {string} fresh ~/.claude stand-in */
function tempClaudeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccsc-'))
}

/**
 * @param {string} claudeHome
 * @param {string} id
 * @param {object[]} entries
 * @returns {string} transcript path
 */
function writeTranscript(claudeHome, id, entries) {
  const dir = path.join(claudeHome, 'projects', '-home-runner-work-repo-repo')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return file
}

/** @param {string} id */
function agentCall(id) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } }
}

/** @param {string} id */
function toolResult(id) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } }
}

const HELLO = { type: 'user', message: { role: 'user', content: 'hello' } }

test('slug collapses separators so one scope cannot prefix-match another', () => {
  assert.is(slug('pr-12'), 'pr-12')
  assert.is(slug('Claude Code'), 'Claude-Code')
  assert.is(slug('a--b'), 'a-b')
  assert.is(slug('x/y z'), 'x-y-z')
})

test('cacheKeys: unique save key per run, prefix restore key per scope+workflow', () => {
  const keys = cacheKeys({ scope: 'pr-12', workflow: 'Claude Code', runId: '99', runAttempt: '2' })
  assert.is(keys.prefix, 'claude-session--pr-12--Claude-Code--')
  assert.is(keys.save, 'claude-session--pr-12--Claude-Code--99-2')
  const other = cacheKeys({ scope: 'pr-1', workflow: 'Claude Code', runId: '99', runAttempt: '2' })
  assert.not.ok(keys.save.startsWith(other.prefix))
})

test('cacheKeys requires a scope', () => {
  assert.throws(() => cacheKeys({ scope: ' ', workflow: 'w', runId: '1', runAttempt: '1' }), /scope is required/)
})

test('transcriptProblem: clean transcript is resumable', () => {
  const text = [HELLO, agentCall('toolu_1'), toolResult('toolu_1')].map((e) => JSON.stringify(e)).join('\n')
  assert.is(transcriptProblem(text), null)
})

test('transcriptProblem: tolerates a half-written final line from a killed run', () => {
  const text = JSON.stringify(HELLO) + '\n{"type":"assist'
  assert.is(transcriptProblem(text), null)
})

test('transcriptProblem: unresolved subagent call blocks resume', () => {
  const text = [HELLO, agentCall('toolu_1'), agentCall('toolu_2'), toolResult('toolu_1')].map((e) => JSON.stringify(e)).join('\n')
  assert.is(transcriptProblem(text), 'the transcript has 1 unresolved subagent call(s)')
})

test('transcriptProblem: legacy Task tool name counts as a subagent call', () => {
  const task = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Task' }] } }
  assert.is(transcriptProblem(JSON.stringify(task)), 'the transcript has 1 unresolved subagent call(s)')
})

test('transcriptProblem: orphaned background tasks block resume', () => {
  const text = JSON.stringify({ type: 'user', message: { content: 'Orphaned by a previous Claude Code process exit' } })
  assert.is(transcriptProblem(text), 'the transcript already replayed orphaned background tasks')
})

test('transcriptProblem: unparseable transcript blocks resume', () => {
  assert.is(transcriptProblem('not json\nalso not'), 'the transcript could not be parsed')
})

test('resolveSession: resumes the recorded session for the same scope', () => {
  const home = tempClaudeHome()
  writeTranscript(home, ID_A, [HELLO])
  recordSession({ claudeHome: home, id: ID_A, scope: 'pr-12' })
  const result = resolveSession({ claudeHome: home, scope: 'pr-12' })
  assert.equal(result, { id: ID_A, args: `--resume ${ID_A}`, reason: '' })
})

test('resolveSession: starts fresh with nothing recorded', () => {
  const result = resolveSession({ claudeHome: tempClaudeHome(), scope: 'pr-12' })
  assert.is(result.id, '')
  assert.is(result.args, '')
  assert.is(result.reason, 'no session id was recorded')
})

test('resolveSession: starts fresh when the recorded session belongs to another scope', () => {
  const home = tempClaudeHome()
  writeTranscript(home, ID_A, [HELLO])
  recordSession({ claudeHome: home, id: ID_A, scope: 'pr-7' })
  const result = resolveSession({ claudeHome: home, scope: 'pr-12' })
  assert.is(result.args, '')
  assert.is(result.reason, 'the recorded session belongs to pr-7, not pr-12')
})

test('resolveSession: starts fresh when the transcript is missing', () => {
  const home = tempClaudeHome()
  recordSession({ claudeHome: home, id: ID_A, scope: 'pr-12' })
  const result = resolveSession({ claudeHome: home, scope: 'pr-12' })
  assert.is(result.reason, `the transcript for ${ID_A} was not restored`)
})

test('resolveSession: starts fresh when the transcript is unsafe', () => {
  const home = tempClaudeHome()
  writeTranscript(home, ID_A, [HELLO, agentCall('toolu_1')])
  recordSession({ claudeHome: home, id: ID_A, scope: 'pr-12' })
  const result = resolveSession({ claudeHome: home, scope: 'pr-12' })
  assert.is(result.reason, 'the transcript has 1 unresolved subagent call(s)')
})

test('resolveSession: rejects a recorded id that is not a session id', () => {
  const home = tempClaudeHome()
  recordSession({ claudeHome: home, id: '../../etc/passwd', scope: 'pr-12' })
  const result = resolveSession({ claudeHome: home, scope: 'pr-12' })
  assert.is(result.reason, 'the recorded session id is not a session id')
})

test('latestSessionId: newest transcript written since the run started', () => {
  const home = tempClaudeHome()
  const old = writeTranscript(home, ID_A, [HELLO])
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(old, past, past)
  const startedAtMs = Date.now() - 1000
  writeTranscript(home, ID_B, [HELLO])
  assert.is(latestSessionId({ claudeHome: home, startedAtMs }), ID_B)
})

test('latestSessionId: ignores restored transcripts and subagent transcripts', () => {
  const home = tempClaudeHome()
  const restored = writeTranscript(home, ID_A, [HELLO])
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(restored, past, past)
  const sub = path.join(path.dirname(restored), ID_A, 'subagents')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'agent-abc.jsonl'), JSON.stringify(HELLO))
  assert.is(latestSessionId({ claudeHome: home, startedAtMs: Date.now() - 1000 }), '')
})

test('recordSession writes id and scope into session-meta', () => {
  const home = tempClaudeHome()
  recordSession({ claudeHome: home, id: ID_A, scope: 'issue-3' })
  assert.is(fs.readFileSync(path.join(home, 'session-meta', 'session-id'), 'utf8'), `${ID_A}\n`)
  assert.is(fs.readFileSync(path.join(home, 'session-meta', 'scope'), 'utf8'), 'issue-3\n')
})

test.run()

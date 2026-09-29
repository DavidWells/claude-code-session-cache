# claude-code-session-cache

GitHub Actions that carry a [Claude Code](https://code.claude.com) session between CI runs on the same Issue or PR.

When a `claude-code-action` run times out, fails, or is cancelled, its conversation is normally gone with the runner. With these actions the next `@claude` run on that Issue/PR resumes the same session (`claude --resume <id>`) instead of re-reading everything from scratch.

## How it works

Claude Code appends every message to `~/.claude/projects/<cwd>/<session-id>.jsonl` as it goes, so the transcript on disk is current even when a run is killed.

- **`restore`** (before Claude): restores the newest cached transcript for `(scope, workflow)` from the Actions cache, checks it is safe to resume, and outputs `resume-args` (`--resume <id>` or empty).
- **`save`** (after Claude, `if: always()`): finds the newest transcript written during this run, records its id + scope, and saves it to the cache under a key unique to the run.

A session is resumed only when all of these hold, otherwise Claude starts fresh:

- the restored cache records a session id and the same scope as this run
- that session's transcript was restored
- the transcript has no subagent (`Agent`/`Task`) call without a result, and no "orphaned background tasks" marker. Resuming those spends the run replaying stale notifications instead of reading the prompt

Only `~/.claude/projects/*/*.jsonl` and `~/.claude/session-meta` are cached, never repo-wide auto-memory.

## Usage

```yaml
jobs:
  claude:
    runs-on: ubuntu-latest
    # Longer than the Claude step timeout so the save step still runs after it times out
    timeout-minutes: 60
    # Needed for issues/issue_comment/pull_request_target triggers (see Caveats)
    cache-mode: write
    steps:
      - uses: actions/checkout@v4

      - name: Restore Claude Session
        id: session
        uses: DavidWells/claude-code-session-cache/restore@<sha>
        with:
          scope: pr-${{ github.event.pull_request.number }}

      - name: Run Claude Code
        uses: anthropics/claude-code-action@v1
        timeout-minutes: 50
        continue-on-error: true
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: --model opus ${{ steps.session.outputs.resume-args }}

      - name: Save Claude Session
        if: always()
        uses: DavidWells/claude-code-session-cache/save@<sha>
```

Pin to a commit SHA.

### Inputs / outputs

| Action    | Input   | Description                                         |
|-----------|---------|-----------------------------------------------------|
| `restore` | `scope` | Work item, e.g. `pr-12` or `issue-34`. Never a branch. |

| Action    | Output        | Description                                        |
|-----------|---------------|----------------------------------------------------|
| `restore` | `resume-args` | `--resume <id>` or empty. Append to `claude_args`. |
| `restore` | `session-id`  | Session being resumed, or empty                    |
| `restore` | `resumed`     | `"true"` / `"false"`                               |
| `save`    | `session-id`  | Session saved, or empty                            |

## Caveats

- **Cache writes on untrusted triggers.** Since 2026-06-26 GitHub issues read-only cache tokens to `issues`, `issue_comment`, `pull_request_target` and fork `workflow_run` runs ([changelog](https://github.blog/changelog/2026-06-26-read-only-actions-cache-for-untrusted-triggers/)). `save` then warns `cache write denied: token has no writable scopes` and the next run starts fresh. Set `cache-mode: write` on the Claude job, and only if that job is gated to trusted actors (e.g. `author_association` OWNER/MEMBER/COLLABORATOR): write access on low-trust triggers reintroduces cache-poisoning risk, and GitHub annotates it with a warning.
- **Save the code too.** The transcript is only the conversation. If Claude's file edits aren't pushed, a resumed session believes changes exist that the fresh checkout lacks. Commit and push unfinished work in an `if: always()` step when the Claude step doesn't succeed.
- **Timeouts.** Set a step-level `timeout-minutes` on Claude shorter than the job's, with `continue-on-error: true`. If the job timeout hits first the job is killed and later steps may not run.
- **Cache scope.** Actions caches are scoped by git ref. `issue_comment` / `issues` / `pull_request_target` runs use the default branch and share caches; `pull_request_review*` runs use the PR ref and can read default-branch caches but not the reverse.
- **Concurrent runs** on one scope both save; the next restore picks the newest.

## Development

```bash
npm install
npm test
```

The `Test` workflow also runs a live save → restore round trip through the real Actions cache.

## Credits

Approach and safety checks adapted from [CVector-Energy/claude-code-session](https://github.com/CVector-Energy/claude-code-session) (MIT), reimplemented as dependency-free composite actions.

## License

MIT

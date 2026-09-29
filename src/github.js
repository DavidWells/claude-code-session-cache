// Writes step outputs and job env vars through the GITHUB_OUTPUT/GITHUB_ENV
// command files, without depending on @actions/core.
const fs = require('fs')
const crypto = require('crypto')

/**
 * @param {string} file
 * @param {string} name
 * @param {string} value
 */
function appendCommand(file, name, value) {
  if (!file) throw new Error(`command file for ${name} is not set`)
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

/**
 * @param {string} name
 * @param {string} value
 */
function setOutput(name, value) {
  appendCommand(process.env.GITHUB_OUTPUT || '', name, value)
}

/**
 * Export an env var to later steps in the job (including the save action).
 * @param {string} name
 * @param {string} value
 */
function exportVariable(name, value) {
  appendCommand(process.env.GITHUB_ENV || '', name, value)
}

module.exports = { setOutput, exportVariable }

#!/usr/bin/env node
/**
 * The `helm7` entry point.
 *
 * Deliberately tiny, and plain JavaScript: everything it does is assemble the
 * real world — argv, env, the home directory, whether stdout is a terminal —
 * and hand it to `main`, which is where all the behaviour lives and where the
 * tests can reach it.
 *
 * It sets `process.exitCode` rather than calling `process.exit`, because
 * `process.exit` truncates output that has not yet flushed to a pipe — and the
 * output being truncated would be the plan somebody piped into a review.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const entry = new URL('../dist/run.js', import.meta.url)

let main
try {
  ;({ main } = await import(entry.href))
} catch (cause) {
  // Only claim "not built" when the missing module is OUR entry point. A
  // module-not-found from deeper in the graph is a different fault, and
  // reporting it as an unbuilt checkout sends the reader to run a build that
  // will succeed and change nothing.
  if (cause?.code !== 'ERR_MODULE_NOT_FOUND' || cause.url !== entry.href) throw cause
  process.stderr.write('helm7: this checkout has not been built. Run `npm run build -w @helm7/cli`.\n')
  process.exitCode = 70
}

if (main) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    version: packageJson.version,
    env: process.env,
    homeDir: homedir(),
    isTty: Boolean(process.stdout.isTTY),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // Absent and unreadable are the same answer to the caller: there is no
        // configuration here. A permission error on a file nobody knew existed
        // is not worth failing a command over.
        return undefined
      }
    },
  })
}

/**
 * Help text, generated from the command table rather than written twice.
 *
 * A hand-written usage block is wrong the day after somebody adds a flag, and
 * nothing fails when it is — which makes it the single most reliably stale
 * thing in a CLI. Deriving it means the help cannot describe a flag the parser
 * does not accept.
 */
import type { FlagSpec } from './args.js'
import type { Command } from './commands.js'

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - text.length))

const usageOf = (command: Command): string => {
  const positionals = (command.positionals ?? []).map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
  return ['helm7', ...command.path, ...positionals, '[options]'].join(' ')
}

function flagLines(flags: readonly FlagSpec[]): string[] {
  if (flags.length === 0) return []
  const rendered = flags.map((flag) => ({
    // A one-letter alias is a short flag (-h); a longer one is a second
    // spelling (--color), and printing it as `-color` would teach the reader a
    // form the parser accepts by accident rather than the one meant.
    left:
      `--${flag.name}${flag.placeholder ? ` ${flag.placeholder}` : ''}` +
      (flag.alias ? `, ${flag.alias.length === 1 ? '-' : '--'}${flag.alias}` : ''),
    summary: flag.summary,
  }))
  const width = Math.max(...rendered.map((r) => r.left.length))
  return rendered.map((r) => `  ${pad(r.left, width)}  ${r.summary}`)
}

export function renderCommandHelp(command: Command, globalFlags: readonly FlagSpec[]): string {
  const lines = [usageOf(command), '', command.summary]

  const positionals = command.positionals ?? []
  if (positionals.length > 0) {
    const width = Math.max(...positionals.map((p) => p.name.length + 2))
    lines.push('', 'Arguments')
    for (const p of positionals) lines.push(`  ${pad(`<${p.name}>`, width)}  ${p.summary}`)
  }

  if (command.flags.length > 0) lines.push('', 'Options', ...flagLines(command.flags))
  lines.push('', 'Global options', ...flagLines(globalFlags))
  lines.push('', `Calls the ${command.operation} operation.`)
  return lines.join('\n')
}

export function renderHelp(commands: readonly Command[], globalFlags: readonly FlagSpec[]): string {
  const rows = commands.map((c) => ({ left: c.path.join(' '), summary: c.summary }))
  const width = Math.max(...rows.map((r) => r.left.length))
  return [
    'helm7: deploy and operate a whole application from one command line.',
    '',
    'Usage: helm7 <command> [options]',
    '',
    'Commands',
    ...rows.map((r) => `  ${pad(r.left, width)}  ${r.summary}`),
    '',
    'Global options',
    ...flagLines(globalFlags),
    '',
    'Every command that changes anything takes --dry-run, which prints what would',
    'happen and what it would cost without doing it. Destructive commands refuse',
    'without --confirm and print the same plan instead.',
    '',
    'Credentials: HELM7_API_KEY, or ~/.helm7/config.json.',
  ].join('\n')
}

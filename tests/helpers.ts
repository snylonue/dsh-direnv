/**
 * Shared prerequisites for the tests that drive REAL child processes.
 *
 * Two hazards this module exists to remove:
 *
 * 1. `/bin/bash` does not exist on every platform (NixOS ships only
 *    `/bin/sh`), so hard-coding it silently skipped the strongest tests on
 *    exactly the machine they were written on.
 * 2. A silently skipped suite looks identical to a passing one. Every skip
 *    here goes through {@link requireBash}, which prints WHY it skipped.
 *
 * @module tests/helpers
 */
import { spawnSync } from 'node:child_process'

/** Whether the real `direnv` binary is usable. */
export const HAS_DIRENV = spawnSync('direnv', ['version'], { encoding: 'utf8' }).status === 0

/**
 * Candidate shells, best first. `DSH_TEST_BASH` wins when set, so a developer
 * can point the suite at a specific interpreter; the rest are the conventional
 * locations, ending with whatever `bash` resolves to on PATH.
 */
function bashCandidates(): string[] {
  const configured = process.env.DSH_TEST_BASH
  return [
    ...configured === undefined || configured.length === 0 ? [] : [configured],
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
    'bash',
  ]
}

/** The first candidate that can actually run a command, or `undefined`. */
export function findBash(): string | undefined {
  return bashCandidates().find((candidate) => {
    try {
      return spawnSync(candidate, ['-c', 'true'], { stdio: 'ignore' }).status === 0
    } catch {
      return false
    }
  })
}

/** The resolved shell for this run; `undefined` when none is usable. */
export const BASH = findBash()

/**
 * Whether a suite needing real child processes may run, printing one labelled
 * line when it may not so a skip is never mistaken for coverage.
 * @param what - the fixture the suite needs, for the diagnostic.
 * @returns true when real-process tests should run.
 */
export function requireRealProcesses(what: string): boolean {
  if (!HAS_DIRENV) {
    console.warn(`[dsh-direnv tests] SKIPPING ${what}: the \`direnv\` binary is not usable on PATH.`)
    return false
  }
  if (BASH === undefined) {
    console.warn(`[dsh-direnv tests] SKIPPING ${what}: no usable bash found (tried ${bashCandidates().join(', ')}). Set DSH_TEST_BASH to one.`)
    return false
  }
  return true
}

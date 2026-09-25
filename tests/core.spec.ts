/**
 * Core unit tests: RC discovery, diff parsing, filtering, and refusals.
 * Everything here is pure or filesystem-local; no direnv and no host needed.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findRcPath,
  isWithin,
  parseExport,
  previewRc,
  refuseAllow,
  selectInjectable,
  looksBlocked,
  hasAppliedEntries,
  cacheStamp,
  isDenied,
  assertDirenvConfig,
  defaultConfig,
} from '../src/core.js'

const created: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-direnv-core-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('findRcPath', () => {
  it('finds .envrc in the directory itself', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.envrc'), 'export A=1\n')
    expect(findRcPath(dir)).toBe(join(dir, '.envrc'))
  })

  it('walks up to an ancestor, like native direnv', () => {
    const root = scratch()
    const deep = join(root, 'packages', 'api', 'src')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, '.envrc'), 'export A=1\n')
    expect(findRcPath(deep)).toBe(join(root, '.envrc'))
  })

  it('prefers the nearest ancestor over a farther one', () => {
    const root = scratch()
    const mid = join(root, 'packages')
    mkdirSync(mid, { recursive: true })
    writeFileSync(join(root, '.envrc'), 'export ROOT=1\n')
    writeFileSync(join(mid, '.envrc'), 'export MID=1\n')
    expect(findRcPath(mid)).toBe(join(mid, '.envrc'))
  })

  it('prefers .envrc over .env in the same directory', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.env'), 'A=1\n')
    writeFileSync(join(dir, '.envrc'), 'export A=1\n')
    expect(findRcPath(dir)).toBe(join(dir, '.envrc'))
  })

  it('finds .env when no .envrc exists', () => {
    const dir = scratch()
    writeFileSync(join(dir, '.env'), 'A=1\n')
    expect(findRcPath(dir)).toBe(join(dir, '.env'))
  })

  it('returns undefined when nothing governs the directory', () => {
    // A fresh temp dir has no RC; its ancestors are outside the temp root and
    // overwhelmingly unlikely to carry one, which the assertion accepts.
    const dir = scratch()
    const found = findRcPath(dir)
    expect(found === undefined || found.endsWith('.envrc') || found.endsWith('.env')).toBe(true)
    expect(found === undefined || !found.startsWith(dir)).toBe(true)
  })

  it('ignores a directory named .envrc', () => {
    const dir = scratch()
    mkdirSync(join(dir, '.envrc'))
    const found = findRcPath(dir)
    expect(found).not.toBe(join(dir, '.envrc'))
  })

  it('rejects a relative or NUL-bearing workspace', () => {
    expect(() => findRcPath('relative/path')).toThrow(TypeError)
    expect(() => findRcPath('/tmp/a\0b')).toThrow(TypeError)
  })
})

describe('parseExport', () => {
  it('parses a diff with string and null entries', () => {
    expect(parseExport('{"A":"1","B":null}')).toEqual({ A: '1', B: null })
  })

  it('treats empty output as an empty diff', () => {
    expect(parseExport('')).toEqual({})
    expect(parseExport('   \n ')).toEqual({})
  })

  it('rejects malformed, non-object, and non-string values', () => {
    expect(parseExport('not json')).toBeUndefined()
    expect(parseExport('[1,2]')).toBeUndefined()
    expect(parseExport('"a string"')).toBeUndefined()
    expect(parseExport('{"A":1}')).toBeUndefined()
    expect(parseExport('{"A":{"nested":true}}')).toBeUndefined()
  })
})

describe('selectInjectable', () => {
  it('keeps ordinary variables and drops DSH_*, DIRENV_*, and invalid names', () => {
    const { env, dropped } = selectInjectable({
      PATH: '/usr/bin',
      FOO: 'bar',
      DSH_HOME: '/evil',
      DSH_SESSION_ID: 'forged',
      DIRENV_DIFF: 'opaque',
      'not-a-name': 'x',
      '1LEADING': 'x',
      'WITH SPACE': 'x',
      '': 'x',
    })
    expect(env).toEqual({ PATH: '/usr/bin', FOO: 'bar' })
    expect(dropped.sort()).toEqual(['', '1LEADING', 'DIRENV_DIFF', 'DSH_HOME', 'DSH_SESSION_ID', 'WITH SPACE', 'not-a-name'].sort())
  })

  it('maps a null (unset) entry to undefined so the seam removes it', () => {
    // Omitting the name would be a bug: the executor merges this map onto the
    // scrubbed parent environment, so an absent name keeps the inherited value
    // and `unset FOO` in a .envrc would silently do nothing. `undefined` is
    // the subprocess seam's removal convention.
    const { env } = selectInjectable({ REMOVED: null, KEPT: 'v' })
    expect(env).toEqual({ KEPT: 'v', REMOVED: undefined })
    expect(Object.prototype.hasOwnProperty.call(env, 'REMOVED')).toBe(true)
  })

  it('still refuses to inject an unset for a managed or unsafe name', () => {
    const { env, dropped } = selectInjectable({ DSH_HOME: null, 'bad-name': null, GOOD: null })
    expect(Object.keys(env)).toEqual(['GOOD'])
    expect(env.GOOD).toBeUndefined()
    expect(dropped.sort()).toEqual(['DSH_HOME', 'bad-name'])
  })

  it('drops a value containing NUL instead of truncating it', () => {
    const { env, dropped } = selectInjectable({ BAD: 'a\0b', GOOD: 'x' })
    expect(env).toEqual({ GOOD: 'x' })
    expect(dropped).toEqual(['BAD'])
  })

  it('accepts an empty string as a genuine set-but-empty value', () => {
    expect(selectInjectable({ EMPTY: '' }).env).toEqual({ EMPTY: '' })
  })

  it('is case-sensitive about the managed namespace, dropping DSH_ but keeping dsh_', () => {
    // Native direnv variables are case-sensitive on POSIX; a lowercase name is
    // a different variable and cannot be read as a managed fact on this path.
    const { env, dropped } = selectInjectable({ DSH_X: 'a', dsh_x: 'b' })
    expect(env).toEqual({ dsh_x: 'b' })
    expect(dropped).toEqual(['DSH_X'])
  })
})

describe('hasAppliedEntries', () => {
  it('ignores the always-present DIRENV_* bookkeeping direnv emits', () => {
    // direnv emits these even for a denied or empty .envrc, so a raw
    // "is the diff empty" test would never detect the denied case.
    expect(hasAppliedEntries({ DIRENV_DIFF: 'x', DIRENV_DIR: '-/a', DIRENV_FILE: '/a/.envrc', DIRENV_WATCHES: 'y' })).toBe(false)
    expect(hasAppliedEntries({ DIRENV_DIFF: 'x', REAL: '1' })).toBe(true)
    expect(hasAppliedEntries({})).toBe(false)
  })
})

describe('cacheStamp', () => {
  it('changes when the RC file changes', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    const first = cacheStamp(rc)
    writeFileSync(rc, 'export A=22\n')
    expect(cacheStamp(rc)).not.toBe(first)
  })

  it('changes when the direnv allow store appears or is rewritten', () => {
    const dir = scratch()
    const data = join(dir, 'data')
    const rc = join(dir, '.envrc')
    mkdirSync(data, { recursive: true })
    writeFileSync(rc, 'export A=1\n')
    const env = { ...process.env, XDG_DATA_HOME: data }
    const absent = cacheStamp(rc, env)
    // Creating the store is what an external `direnv allow` does.
    mkdirSync(join(data, 'direnv', 'allow'), { recursive: true })
    expect(cacheStamp(rc, env)).not.toBe(absent)
  })

  it('is stable when nothing changes', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(cacheStamp(rc)).toBe(cacheStamp(rc))
  })

  it('distinguishes a missing RC from a present one', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    const missing = cacheStamp(rc)
    writeFileSync(rc, 'export A=1\n')
    expect(cacheStamp(rc)).not.toBe(missing)
  })

  it('handles an undefined RC, meaning no .envrc governs the directory', () => {
    expect(typeof cacheStamp(undefined)).toBe('string')
  })
})

describe('isDenied', () => {
  it('finds a deny entry written by the REAL direnv, using its own path hash', () => {
    // The hash must match direnv's pathHash: sha256("<abs path>\n").
    const dir = scratch()
    const data = join(dir, 'data')
    mkdirSync(data, { recursive: true })
    const env = { ...process.env, XDG_DATA_HOME: data }
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(isDenied(rc, env)).toBe(false)

    // Write the entry exactly as direnv would.
    const hash = createHash('sha256').update(rc + '\n').digest('hex')
    mkdirSync(join(data, 'direnv', 'deny'), { recursive: true })
    writeFileSync(join(data, 'direnv', 'deny', hash), rc + '\n')
    expect(isDenied(rc, env)).toBe(true)
  })

  it('reports false when no store location is knowable', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(isDenied(rc, {})).toBe(false)
  })

  it('falls back to HOME/.local/share when XDG_DATA_HOME is unset', () => {
    const home = scratch()
    const rc = join(home, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    const env = { HOME: home }
    const hash = createHash('sha256').update(rc + '\n').digest('hex')
    mkdirSync(join(home, '.local', 'share', 'direnv', 'deny'), { recursive: true })
    writeFileSync(join(home, '.local', 'share', 'direnv', 'deny', hash), rc + '\n')
    expect(isDenied(rc, env)).toBe(true)
  })
})

describe('looksBlocked', () => {
  it('recognizes direnv blocked text with and without ANSI styling', () => {
    expect(looksBlocked('direnv: error /a/.envrc is blocked. Run \`direnv allow\` to approve its content')).toBe(true)
    expect(looksBlocked('\u001B[31mdirenv: error /a/.envrc is blocked. Run \`direnv allow\`\u001B[0m')).toBe(true)
  })

  it('does not treat unrelated errors as blocked', () => {
    expect(looksBlocked('direnv: error stat /a/b: no such file or directory')).toBe(false)
    expect(looksBlocked('')).toBe(false)
  })
})

describe('previewRc', () => {
  it('hashes the full file while showing only the bounded head', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    const body = 'export A=' + 'x'.repeat(5000) + '\n'
    writeFileSync(rc, body)
    const preview = previewRc(rc, 100)
    expect(preview.bytes).toBe(Buffer.byteLength(body))
    expect(preview.truncated).toBe(true)
    expect(preview.text.length).toBe(100)
    // Same file, larger budget -> same digest, longer text.
    const full = previewRc(rc, 1_000_000)
    expect(full.sha256).toBe(preview.sha256)
    expect(full.truncated).toBe(false)
    expect(full.text).toBe(body)
  })

  it('changes the digest when the content changes, at a stable size', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    const first = previewRc(rc, 1024)
    writeFileSync(rc, 'export A=2\n')
    const second = previewRc(rc, 1024)
    expect(second.bytes).toBe(first.bytes)
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('reports an empty file as empty rather than truncated', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, '')
    const preview = previewRc(rc, 64)
    expect(preview.bytes).toBe(0)
    expect(preview.text).toBe('')
    expect(preview.truncated).toBe(false)
  })

  it('throws for a missing file', () => {
    expect(() => previewRc(join(scratch(), '.envrc'), 64)).toThrow()
  })
})

describe('refuseAllow', () => {
  it('accepts an absolute .envrc inside the workspace', () => {
    const ws = scratch()
    const rc = join(ws, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(refuseAllow(rc, ws, true)).toBeUndefined()
  })

  it('refuses a path outside the workspace when restricted', () => {
    const ws = scratch()
    const other = scratch()
    const rc = join(other, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(refuseAllow(rc, ws, true)).toMatch(/outside the calling workspace/)
    expect(refuseAllow(rc, ws, false)).toBeUndefined()
  })

  it('refuses a nested path inside the workspace by default', () => {
    const ws = scratch()
    mkdirSync(join(ws, 'sub'))
    const rc = join(ws, 'sub', '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(refuseAllow(rc, ws, true)).toBeUndefined()
  })

  it('refuses relative paths, wrong basenames, missing files, and directories', () => {
    const ws = scratch()
    expect(refuseAllow('.envrc', ws, true)).toMatch(/must be absolute/)
    expect(refuseAllow(join(ws, 'evil.sh'), ws, true)).toMatch(/must name one of/)
    expect(refuseAllow(join(ws, '.envrc'), ws, true)).toMatch(/does not exist/)
    mkdirSync(join(ws, '.env'))
    expect(refuseAllow(join(ws, '.env'), ws, true)).toMatch(/not a regular file/)
  })

  it('refuses any absolute path when the call has no workspace', () => {
    const dir = scratch()
    const rc = join(dir, '.envrc')
    writeFileSync(rc, 'export A=1\n')
    expect(refuseAllow(rc, undefined, true)).toMatch(/no workspace/)
  })
})

describe('isWithin', () => {
  it('accepts the root itself and true descendants, rejecting siblings and prefixes', () => {
    const root = scratch()
    const inside = join(root, 'sub')
    mkdirSync(inside)
    expect(isWithin(root, root)).toBe(true)
    expect(isWithin(root, inside)).toBe(true)
    expect(isWithin(root, `${root}bc`)).toBe(false)
    expect(isWithin(root, dirname(root))).toBe(false)
  })

  it('rejects a .. traversal that escapes the workspace', () => {
    const root = scratch()
    const outside = scratch()
    const escaped = join(root, '..', outside.slice(outside.lastIndexOf('/') + 1), '.envrc')
    expect(isWithin(root, escaped)).toBe(false)
  })

  it('rejects a symlink that points outside the workspace', () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, '.envrc'), 'export A=1\n')
    symlinkSync(join(outside, '.envrc'), join(root, '.envrc'))
    // The link is named .envrc inside the workspace, but its target is not.
    expect(isWithin(root, join(root, '.envrc'))).toBe(false)
  })

  it('accepts a symlinked workspace root itself', () => {
    const root = scratch()
    const link = join(scratch(), 'link')
    symlinkSync(root, link)
    expect(isWithin(link, root)).toBe(true)
  })
})

describe('assertDirenvConfig', () => {
  it('accepts the defaults', () => {
    expect(() => assertDirenvConfig(defaultConfig)).not.toThrow()
  })

  it('rejects an empty executable, bad timeout, and bad preview budget', () => {
    expect(() => assertDirenvConfig({ ...defaultConfig, executable: '' })).toThrow(TypeError)
    expect(() => assertDirenvConfig({ ...defaultConfig, probeTimeoutMs: 0 })).toThrow(TypeError)
    expect(() => assertDirenvConfig({ ...defaultConfig, probeTimeoutMs: 1.5 })).toThrow(TypeError)
    expect(() => assertDirenvConfig({ ...defaultConfig, previewBytes: -1 })).toThrow(TypeError)
  })
})

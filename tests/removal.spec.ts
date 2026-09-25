import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BashLocal from '@deepseek-ai/dsh-bash-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'

class FakeAgents extends Service {
  constructor(ctx: Context) { super(ctx, 'agents') }
  currentInitiator() { return undefined }
}

describe('seam removal convention', () => {
  it('honours an undefined env value as removal from the real child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-direnv-remove-'))
    const ws = join(root, 'ws'); mkdirSync(ws, { recursive: true })
    const saved = { ...process.env }
    process.env.REMOVE_ME = 'from-parent'
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    fibers.push(await ctx.plugin(SubprocessLocal))
    fibers.push(await ctx.plugin(BashLocal, { cwd: ws }))
    fibers.push(await ctx.plugin(FakeAgents))
    try {
      const spec = ctx.shell.resolve({
        command: 'printf "[%s]" "${REMOVE_ME-unset}"',
        env: { REMOVE_ME: undefined as unknown as string },
      } as never)
      const result = await ctx.shell.run(spec)
      console.log('undefined-value child saw:', result.stdout.text)
      expect(result.stdout.text).toBe('[unset]')
    } finally {
      for (const f of fibers.reverse()) await f.dispose()
      process.env = saved
      rmSync(root, { recursive: true, force: true })
    }
  })
})

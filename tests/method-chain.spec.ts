/**
 * Method-chain tests, focused on the property the overlay's descriptor-
 * restoring wrapper gets wrong: disposal is monotonic and order-independent.
 *
 * @module tests/method-chain
 */
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { installChainLink } from '../src/method-chain.js'

class Greeter {
  greet(name: string): string {
    return 'base(' + name + ')'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Declared here so this test can address the service through its proxy. */
    greeter: GreeterService
  }
}

class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }
  greet(name: string): string {
    return 'base(' + name + ')'
  }
}

describe('installChainLink', () => {
  it('wraps and restores the original method', () => {
    const target = new Greeter()
    const original = target.greet
    const link = installChainLink(target, 'greet', (next) => 'A' + String(next()))
    expect(target.greet('x')).toBe('Abase(x)')
    link.dispose()
    expect(target.greet('x')).toBe('base(x)')
    expect(target.greet).toBe(original)
  })

  it('composes nested links innermost-first', () => {
    const target = new Greeter()
    const a = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    const b = installChainLink(target, 'greet', (next) => 'B(' + String(next()) + ')')
    expect(target.greet('x')).toBe('B(A(base(x)))')
    b.dispose()
    expect(target.greet('x')).toBe('A(base(x))')
    a.dispose()
    expect(target.greet('x')).toBe('base(x)')
  })

  it('disposing an EARLIER link before a LATER one never resurrects it', () => {
    // The regression this design exists to prevent: a descriptor-restoring
    // wrapper resurrects a dead sibling when disposal is not LIFO.
    const target = new Greeter()
    const a = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    const b = installChainLink(target, 'greet', (next) => 'B(' + String(next()) + ')')
    a.dispose()
    expect(target.greet('x')).toBe('B(base(x))')
    b.dispose()
    expect(target.greet('x')).toBe('base(x)')
    expect(target.greet('x').startsWith('A')).toBe(false)
  })

  it('disposing in strictly reverse order also fully restores', () => {
    const target = new Greeter()
    const a = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    const b = installChainLink(target, 'greet', (next) => 'B(' + String(next()) + ')')
    const c = installChainLink(target, 'greet', (next) => 'C(' + String(next()) + ')')
    c.dispose(); b.dispose(); a.dispose()
    expect(target.greet('x')).toBe('base(x)')
    expect(Object.prototype.hasOwnProperty.call(target, 'greet')).toBe(false)
  })

  it('is idempotent and tolerates interleaved disposal', () => {
    const target = new Greeter()
    const a = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    const b = installChainLink(target, 'greet', (next) => 'B(' + String(next()) + ')')
    a.dispose(); a.dispose(); b.dispose(); b.dispose()
    expect(target.greet('x')).toBe('base(x)')
  })

  it('preserves the receiver and the argument list', () => {
    const target = new Greeter()
    let seen: unknown
    const link = installChainLink(target, 'greet', function (next, thisArg, args) {
      seen = { thisArg, args }
      return next()
    })
    target.greet('x')
    expect(seen).toEqual({ thisArg: target, args: ['x'] })
    link.dispose()
  })

  it('forwards replaced arguments through next(...)', () => {
    const target = new Greeter()
    const link = installChainLink(target, 'greet', (next) => next('replaced'))
    expect(target.greet('x')).toBe('base(replaced)')
    link.dispose()
  })

  it('rejects a missing or non-function method', () => {
    const target = new Greeter()
    expect(() => installChainLink(target, 'absent' as 'greet', () => 1)).toThrow(TypeError)
    const holder = { value: 42 }
    expect(() => installChainLink(holder, 'value' as never, () => 1)).toThrow(TypeError)
  })

  it('wraps the provider target behind a Cordis proxy, not the shadow', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(GreeterService)
    const raw = ctx.get('greeter') as GreeterService
    const link = installChainLink(ctx.greeter as unknown as GreeterService, 'greet', (next) => 'A(' + String(next()) + ')')
    // Both the proxy and the raw provider observe the wrapper: it was applied
    // to the provider target, never to a consumer's shadow.
    expect(ctx.greeter.greet('x')).toBe('A(base(x))')
    expect(raw.greet('x')).toBe('A(base(x))')
    // The provider target itself carries the trampoline; the consumer's proxy is
    // a shadow and was never given an own `greet` by this module.
    expect(typeof (ctx.greeter as unknown as Record<PropertyKey, unknown>)[symbols.original]).toBe('object')
    link.dispose()
    expect(ctx.greeter.greet('x')).toBe('base(x)')
    await fiber.dispose()
  })

  it('leaves a foreign reassignment alone when the last link leaves', () => {
    const target = new Greeter()
    const link = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    target.greet = () => 'foreign'
    link.dispose()
    expect(target.greet('x')).toBe('foreign')
  })

  it('restores an inherited method by deleting the own property', () => {
    class Sub extends Greeter {}
    const target = new Sub()
    const link = installChainLink(target, 'greet', (next) => 'A(' + String(next()) + ')')
    expect(Object.prototype.hasOwnProperty.call(target, 'greet')).toBe(true)
    link.dispose()
    expect(Object.prototype.hasOwnProperty.call(target, 'greet')).toBe(false)
    expect(target.greet('x')).toBe('base(x)')
  })

  it('survives a link that throws, still restoring on disposal', () => {
    const target = new Greeter()
    const link = installChainLink(target, 'greet', () => { throw new Error('boom') })
    expect(() => target.greet('x')).toThrow('boom')
    link.dispose()
    expect(target.greet('x')).toBe('base(x)')
  })
})

/**
 * A minimal, monotonic method wrapper for provider-owned service targets.
 *
 * DSH services are reached through Cordis traceable proxies; only the
 * `symbols.original` target may be mutated, never a consumer's shadow.
 *
 * Unlike a "record the previous descriptor and restore it" design, this one
 * keeps an ordered live list per (target, method). One trampoline is installed
 * once and dispatches through the wrappers that are still alive, innermost
 * first. Disposal removes a wrapper from that list, so:
 *
 * - disposing an EARLIER wrapper can never resurrect it when a LATER one is
 *   disposed (the classic non-LIFO bug of descriptor-restoring wrappers);
 * - disposal is monotonic and order-independent;
 * - the original descriptor is restored exactly when the last wrapper leaves,
 *   and only if the target still holds our own trampoline.
 *
 * @module dsh-direnv/method-chain
 */
import { getPropertyDescriptor, symbols } from '@deepseek-ai/cordis'

/**
 * A link in the chain. `next` reaches the next inner link, or the original
 * method when this is the innermost one; calling it with no arguments forwards
 * the link's own arguments unchanged.
 */
export type ChainWrapper<T extends object, K extends keyof T> = (
  next: (...forwarded: unknown[]) => unknown,
  thisArg: T,
  args: unknown[],
) => unknown

/** The installed chain; disposing a link reverts the target when it was the last. */
export interface ChainHandle {
  /** Remove this link. Idempotent; safe in any relative order. */
  dispose(): void
}

interface Link {
  alive: boolean
  invoke: (next: () => unknown, thisArg: unknown, args: unknown[]) => unknown
}

interface ChainState {
  links: Link[]
  original: unknown
  hadOwn: boolean
  before: PropertyDescriptor | undefined
  trampoline: unknown
}

const chains = new WeakMap<object, Map<string | symbol, ChainState>>()

/** Resolve the real provider target behind an optional Cordis traceable proxy. */
function targetOf<T extends object>(value: T): object {
  const original = (value as T & { [symbols.original]?: unknown })[symbols.original]
  return (typeof original === 'object' && original !== null ? original : value) as object
}

/**
 * Install `invoke` as one link in the chain for `method` on the provider
 * target behind `value`.
 *
 * @param value - the raw provider instance or any Cordis proxy/shadow for it.
 * @param method - the method key to wrap.
 * @param invoke - the link; call `next()` to reach the next inner link or the original.
 * @returns the handle that removes exactly this link.
 * @throws TypeError when the method is missing or not a function.
 */
export function installChainLink<T extends object, K extends keyof T>(
  value: T,
  method: K,
  invoke: ChainWrapper<T, K>,
): ChainHandle {
  const target = targetOf(value)
  const key = method as string | symbol
  let perTarget = chains.get(target)
  if (perTarget === undefined) {
    perTarget = new Map()
    chains.set(target, perTarget)
  }
  let state = perTarget.get(key)
  if (state === undefined) {
    const before = getPropertyDescriptor(target, key)
    if (before === undefined || typeof before.value !== 'function') {
      throw new TypeError(`dsh-direnv: cannot wrap non-function method ${String(method)}`)
    }
    const fresh: ChainState = {
      links: [],
      original: before.value,
      hadOwn: Object.prototype.hasOwnProperty.call(target, method),
      before,
      trampoline: undefined,
    }
    const dispatch = (thisArg: unknown, args: unknown[]): unknown => {
      // Newest-outermost: a link installed later wraps the ones already there,
      // which is the conventional middleware order and the order callers of a
      // replaced method observe. Iterating a reversed snapshot also makes the
      // dispatch immune to a link disposing itself mid-call.
      const live = fresh.links.filter((link) => link.alive).reverse()
      let index = 0
      const step = (...nextArgs: unknown[]): unknown => {
        const link = live[index++]
        if (link === undefined) {
          return Reflect.apply(fresh.original as (...a: unknown[]) => unknown, thisArg, nextArgs.length === 0 ? args : nextArgs)
        }
        return link.invoke(step, thisArg, nextArgs.length === 0 ? args : nextArgs)
      }
      return step()
    }
    const trampoline = function (this: unknown, ...args: unknown[]): unknown {
      return dispatch(this, args)
    }
    fresh.trampoline = trampoline
    Object.defineProperty(target, method, {
      value: trampoline,
      writable: true,
      configurable: true,
      enumerable: before.enumerable ?? false,
    })
    state = fresh
    perTarget.set(key, state)
  }
  const link: Link = { alive: true, invoke: invoke as unknown as Link['invoke'] }
  state.links.push(link)
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      link.alive = false
      const current = state as ChainState
      const index = current.links.indexOf(link)
      if (index >= 0) current.links.splice(index, 1)
      if (current.links.length > 0) return
      // Last link gone: restore the exact pre-install state, but only while the
      // target still holds OUR trampoline (a later foreign reassignment wins).
      if ((target as Record<PropertyKey, unknown>)[key] !== current.trampoline) return
      if (current.hadOwn && current.before !== undefined) {
        Object.defineProperty(target, key, current.before)
      } else {
        Reflect.deleteProperty(target, key)
      }
      perTarget?.delete(key)
    },
  }
}

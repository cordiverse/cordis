import { Context, Service } from 'cordis'
import { defineProperty } from 'cosmokit'

declare module 'cordis' {
  interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce'> {
    timer: TimerService
  }
}

type WithDispose<T> = T & { dispose: () => void }

export class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['timeout', 'interval', 'throttle', 'debounce'])
  }

  timeout(callback: () => void, delay: number): () => void
  timeout(delay: number): Promise<void>
  timeout(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      const dispose = this.ctx.effect(() => {
        const timer = setTimeout(() => {
          dispose()
          callback()
        }, delay)
        return () => clearTimeout(timer)
      }, 'ctx.timeout()')
      return dispose
    } else {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      const dispose = this.ctx.effect(() => {
        const timer = setTimeout(resolve, delay)
        return () => {
          clearTimeout(timer)
          reject(new Error('Context has been disposed'))
        }
      }, 'ctx.timeout()')
      return promise.finally(dispose)
    }
  }

  interval(callback: () => void, delay: number): () => void
  interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
  interval(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      return this.ctx.effect(() => {
        const timer = setInterval(callback, delay)
        return () => clearInterval(timer)
      }, 'ctx.interval()')
    } else {
      let doneTask: Promise<IteratorResult<void>> | undefined
      let nextTask: PromiseWithResolvers<IteratorResult<void>> | undefined
      const dispose = this.ctx.effect(() => {
        const timer = setInterval(() => {
          nextTask?.resolve({ done: false, value: undefined })
        }, delay)
        return () => {
          clearInterval(timer)
          if (doneTask) return
          doneTask = Promise.reject(new Error('Context has been disposed'))
          nextTask?.reject(doneTask)
        }
      }, 'ctx.interval()')
      return {
        next: () => {
          if (doneTask) return doneTask
          return (nextTask = Promise.withResolvers()).promise
        },
        return: (value) => {
          doneTask = Promise.resolve({ done: true, value })
          nextTask?.resolve(doneTask)
          dispose()
          return doneTask
        },
        throw: (error) => {
          doneTask = Promise.reject(error)
          nextTask?.reject(error)
          dispose()
          return doneTask
        },
        [Symbol.asyncIterator]() {
          return this
        },
      } satisfies AsyncIterableIterator<void>
    }
  }

  private _schedule(label: string, trigger: (args: any[], isDisposed: boolean) => any, noTrailing = false) {
    this.ctx.fiber.assertActive()

    let timer: number | NodeJS.Timeout | undefined
    const dispose = defineProperty(() => {
      noTrailing = true
      remove()
      clearTimeout(timer)
    }, Context.effect, { label, children: [] })

    const wrapper: any = (...args: any[]) => {
      clearTimeout(timer)
      timer = trigger(args, noTrailing)
    }
    wrapper.dispose = dispose
    const remove = this.ctx.fiber.disposables.push(dispose)
    return wrapper
  }

  throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F> {
    let lastCall = -Infinity
    const execute = (...args: any[]) => {
      lastCall = Date.now()
      callback(...args)
    }
    return this._schedule('ctx.throttle()', (args, isDisposed) => {
      const now = Date.now()
      const remaining = delay - now + lastCall
      if (remaining <= 0) {
        execute(...args)
      } else if (!isDisposed) {
        return setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F> {
    return this._schedule('ctx.debounce()', (args, isDisposed) => {
      if (isDisposed) return
      return setTimeout(callback, delay, ...args)
    })
  }
}

export default TimerService

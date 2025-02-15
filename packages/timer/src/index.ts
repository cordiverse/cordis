import { Context, Service } from '@cordisjs/core'

declare module '@cordisjs/core' {
  interface Context {
    timer: TimerService
    setTimeout(callback: () => void, delay: number): () => void
    setInterval(callback: () => void, delay: number): () => void
    sleep(delay: number): Promise<void>
    throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F>
    debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F>
  }
}

type WithDispose<T> = T & { dispose: () => void }

export class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['setTimeout', 'setInterval', 'sleep', 'throttle', 'debounce'])
  }

  setTimeout(callback: () => void, delay: number) {
    const dispose = this.ctx.effect(() => {
      const timer = setTimeout(() => {
        dispose()
        callback()
      }, delay)
      return () => clearTimeout(timer)
    })
    return dispose
  }

  setInterval(callback: () => void, delay: number) {
    return this.ctx.effect(() => {
      const timer = setInterval(callback, delay)
      return () => clearInterval(timer)
    })
  }

  sleep(delay: number) {
    const caller = this.ctx
    return new Promise<void>((resolve, reject) => {
      const dispose1 = this.setTimeout(() => {
        dispose1()
        dispose2()
        resolve()
      }, delay)
      const dispose2 = caller.on('dispose', () => {
        dispose1()
        dispose2()
        reject(new Error('Context has been disposed'))
      })
    })
  }

  private createWrapper(callback: (args: any[], check: () => boolean) => any, isDisposed = false) {
    this.ctx.scope.assertActive()

    let timer: number | NodeJS.Timeout | undefined
    const dispose = () => {
      isDisposed = true
      remove()
      clearTimeout(timer)
    }

    const wrapper: any = (...args: any[]) => {
      clearTimeout(timer)
      timer = callback(args, () => !isDisposed && this.ctx.scope.active)
    }
    wrapper.dispose = dispose
    const remove = this.ctx.scope.disposables.push(dispose)
    return wrapper
  }

  throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F> {
    let lastCall = -Infinity
    const execute = (...args: any[]) => {
      lastCall = Date.now()
      callback(...args)
    }
    return this.createWrapper((args, isActive) => {
      const now = Date.now()
      const remaining = delay - (now - lastCall)
      if (remaining <= 0) {
        execute(...args)
      } else if (isActive()) {
        return setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F> {
    return this.createWrapper((args, isActive) => {
      if (!isActive()) return
      return setTimeout(callback, delay, ...args)
    })
  }
}

export default TimerService

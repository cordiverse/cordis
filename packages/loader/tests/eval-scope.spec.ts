import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context, FiberState } from 'cordis'
import MockLoader, { sleep } from './utils.ts'

// `!!js` expressions read services, so which services they can see decides what
// they mean. Each option is evaluated in its own scope: `inject` values in the
// parent scope, `disabled` and `intercept` in the entry injection scope, and
// `config` on the plugin fiber.
describe('Loader: entry evaluation scope', () => {
  const root = new Context()

  let loader!: MockLoader
  let settings!: any
  let env!: any
  let worker!: any
  let needy!: any
  let http!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    settings = loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    env = loader.mock('env', (ctx: Context, config: any) => {
      ctx.provide('env', { ...config })
    })
    worker = loader.mock('worker', () => {})
    needy = loader.mock('needy', () => {})
    // the plugin's own dependency, which only `needy` injects
    Object.assign(needy, { inject: ['http'] })
    http = loader.mock('http', (ctx: Context, config: any) => {
      ctx.provide('http', { ...config })
    })
  })

  beforeEach(() => {
    for (const fn of [settings, env, worker, needy]) fn.mock.resetCalls()
  })

  it('needs no gate when the entry declares no inject', async () => {
    await loader.read([{ id: 'worker', name: 'worker', disabled: { __jsExpr: 'false' } }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.undefined
    expect(entry.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('[row2.pos] evaluates disabled against the entry injection scope', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
      config: { workerEnabled: false },
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(0)
  })

  // the plugin's own inject is checked after `disabled`, so a disabled entry
  // must not report as pending on a dependency the plugin never gets to
  it('reports disabled rather than pending on a missing plugin dependency', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
      config: { workerEnabled: false },
    }, {
      id: 'needy',
      name: 'needy',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.needy
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber).to.be.undefined
    expect(needy.mock.calls).to.have.length(0)
  })

  it('[row2.neg] keeps a service the entry does not inject out of the evaluation scope', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'env',
        name: 'env',
        config: { mode: 'dev' },
      }, {
        id: 'settings',
        name: 'settings',
      }, {
        id: 'worker',
        name: 'worker',
        inject: { settings: true },
        // `env` is provided by a sibling but not injected by this entry
        disabled: { __jsExpr: 'env.mode === "dev"' },
      }])
      await sleep()

      const entry = loader.store.worker
      expect(entry.disabled).to.equal(true)
      expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
      expect(worker.mock.calls).to.have.length(0)
      expect(logged).to.have.length(1)
      expect(String(logged[0][0])).to.match(/without inject/)
    } finally {
      ;(root.logger as any).error = error
    }
  })

  // the exclusion above is a service the entry does not inject at all; the
  // nearest one is the service only the plugin itself injects, which belongs to
  // row 4 and must not reach the row 2 scope
  it('[row2.neg] keeps the service only the plugin injects out of the evaluation scope', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'http',
        name: 'http',
        config: { base: 'http://x' },
      }, {
        id: 'settings',
        name: 'settings',
      }, {
        id: 'gated-neg',
        name: 'needy',
        inject: { settings: true },
        disabled: { __jsExpr: 'http.base === "http://x"' },
      }])
      await sleep()

      const entry = loader.store['gated-neg']
      expect(entry.disabled).to.equal(true)
      expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
      expect(needy.mock.calls).to.have.length(0)
      expect(logged).to.have.length(1)
      expect(String(logged[0][0])).to.match(/cannot get property "http" without inject|http is not defined/)
    } finally {
      ;(root.logger as any).error = error
    }
  })

  it('[row4.pos2] evaluates config on the plugin fiber, which also sees the entry inject', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
      config: { namespace: 'ns' },
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      config: { namespace: { __jsExpr: 'settings.namespace' } },
    }])
    await sleep()

    expect(worker.mock.calls).to.have.length(1)
    expect(worker.mock.calls[0].arguments[1]).to.deep.equal({ namespace: 'ns' })
  })

  // a gated entry (an expression in `disabled`) must interpolate its config on
  // the plugin fiber the same way; the gate must not make the leaf guard treat
  // the plugin as a nested one and skip interpolation
  it('[row4.pos2] evaluates config on the plugin fiber of a gated entry', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
      config: { namespace: 'ns' },
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: 'false' },
      config: { namespace: { __jsExpr: 'settings.namespace' } },
    }])
    await sleep()

    expect(loader.store.worker.gate).to.be.ok
    expect(worker.mock.calls).to.have.length(1)
    expect(worker.mock.calls[0].arguments[1]).to.deep.equal({ namespace: 'ns' })
  })

  // row 4 is the row the entry scope cannot explain: the plugin's own `inject`
  // is part of the config scope and of nothing narrower
  it('[row4.pos] reads a service only the plugin injects from config', async () => {
    await loader.read([{
      id: 'http',
      name: 'http',
      config: { base: 'http://x' },
    }, {
      id: 'probe-pos',
      name: 'needy',
      config: { url: { __jsExpr: 'http.base' } },
    }])
    await sleep()

    expect(needy.mock.calls).to.have.length(1)
    expect(needy.mock.calls[0].arguments[1]).to.deep.equal({ url: 'http://x' })
  })

  // and the row is not a free-for-all: the widest scope is parent + entry
  // inject + the plugin's own inject, so a sibling nobody injects stays out
  it('[row4.neg] keeps a service nobody injects out of config', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'http',
        name: 'http',
        config: { base: 'http://x' },
      }, {
        id: 'settings',
        name: 'settings',
      }, {
        id: 'probe-neg',
        name: 'worker',
        config: { url: { __jsExpr: 'http.base' } },
      }])
      await sleep()
    } finally {
      ;(root.logger as any).error = error
    }

    expect(worker.mock.calls).to.have.length(0)
    expect(logged).to.have.length(1)
    expect(String(logged[0][0])).to.match(/cannot get property "http" without inject|http is not defined/)
  })

  // the coordinator is what calls `load()`, so the plugin fiber is instantiated
  // under it and unloading the coordinator takes the plugin with it. Nothing
  // observable in the suite separates that from a sibling fiber, so the
  // structure is asserted directly: without this, reverting to a sibling
  // passes every test while the hierarchy is gone.
  it('creates the plugin fiber under the coordinator that instantiates it', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
      config: { namespace: 'ns' },
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: 'false' },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.fiber).to.be.ok
    // fibers are proxied, so the identity is the uid rather than the reference
    expect(entry.fiber!.parent.fiber!.uid).to.equal(entry.gate!.uid)
  })

  // without `inject` the entry scope is the parent scope, so the option has
  // nothing left to wait for and the entry can settle on its own
  it('reports a failing expression without a coordinator', async () => {
    const broken = loader.mock('broken', () => {})
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'broken',
        name: 'broken',
        disabled: { __jsExpr: 'nope.enabled' },
      }])
      await sleep()

      const entry = loader.store.broken
      expect(entry.gate).to.be.undefined
      expect(logged).to.have.length(1)
      expect(String(logged[0][0])).to.match(/nope is not defined/)
      expect(entry.disabled).to.equal(true)
      expect(entry.fiber).to.be.undefined
      expect(broken.mock.calls).to.have.length(0)
    } finally {
      ;(root.logger as any).error = error
    }
  })
})

// an object-form `inject` value is evaluated in the parent scope, so it cannot
// see the other keys of the same block: that scope does not bind them
describe('Loader: inject values', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    root.provide('env', { namespace: 'ns', tag: 'tag' })
    loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    worker = loader.mock('worker', () => {})
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  it('[row1.pos] evaluates object-form values in the parent scope', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: { namespace: { __jsExpr: 'env.namespace' } } },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.inject).to.deep.equal({ settings: { namespace: 'ns' } })
    expect(entry.fiber!.inject).to.deep.equal({ settings: { namespace: 'ns' } })
    // the source options keep the expression
    expect(entry.options.inject).to.deep.equal({ settings: { namespace: { __jsExpr: 'env.namespace' } } })
    expect(worker.mock.calls).to.have.length(1)
  })

  it('keeps the array form as it is', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: ['settings'],
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.inject).to.deep.equal({ settings: null })
    expect(worker.mock.calls).to.have.length(1)
  })

  it('[row1.neg2] rejects a sibling key in the same block', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'settings',
        name: 'settings',
      }, {
        id: 'worker',
        name: 'worker',
        inject: {
          a: { __jsExpr: 'env.namespace' },
          b: { __jsExpr: 'a + "!"' },
        },
      }])
      await sleep()

      // the values are resolved before the entry scope exists, so `a` is unbound
      expect(logged).to.have.length(1)
      expect(String(logged[0][0])).to.match(/a is not defined/)
      expect(loader.store.worker.disabled).to.equal(true)
      expect(loader.store.worker.fiber?.state).to.not.equal(FiberState.ACTIVE)
    } finally {
      ;(root.logger as any).error = error
    }
  })

  it('interpolates an expression nested in an array', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: { tags: [{ __jsExpr: 'env.tag' }] } },
    }])
    await sleep()

    expect(loader.store.worker.inject).to.deep.equal({ settings: { tags: ['tag'] } })
  })

  // The values resolve in the parent scope, where a service another entry
  // provides is not declared — only a service the root declares is, which is why
  // the case above reads `env`. `disabled` and `intercept` are the fields that
  // see the entry injection scope, so a sibling's service belongs there.
  it('[row1.neg] cannot read a service a sibling entry provides from an inject value', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'settings',
        name: 'settings',
      }, {
        id: 'worker',
        name: 'worker',
        inject: { settings: { namespace: { __jsExpr: 'settings.namespace' } } },
      }])
      await sleep()

      expect(logged).to.have.length(1)
      // the text depends on whether an earlier read already declared the
      // service on its own context: both forms say the same thing
      expect(String(logged[0][0])).to.match(/cannot get property "settings" without inject|settings is not defined/)
      expect(loader.store.worker.disabled).to.be.true
      expect(worker.mock.calls).to.have.length(0)
    } finally {
      ;(root.logger as any).error = error
    }
  })
})

describe('Loader: intercept expression', () => {
  const root = new Context()

  let loader!: MockLoader
  let seen: any
  let needy: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('env', (ctx: Context, config: any) => {
      ctx.provide('env', { ...config })
    })
    loader.mock('settings', (ctx: Context) => {
      ctx.provide('settings', {})
    })
    loader.mock('worker', (ctx: Context) => {
      seen = ctx[Context.intercept]
    })
    loader.mock('http', (ctx: Context, config: any) => {
      ctx.provide('http', { ...config })
    })
    needy = loader.mock('needy', () => {})
    Object.assign(needy, { inject: ['http'] })
  })

  it('[row3.pos] evaluates intercept in the entry injection scope', async () => {
    await loader.read([{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, {
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { env: true, settings: true },
      intercept: { settings: { namespace: { __jsExpr: 'env.proxy' } } },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.intercept).to.deep.equal({ settings: { namespace: 'p1' } })
    expect(seen.settings).to.deep.equal({ namespace: 'p1' })
    // the parent scope's table is untouched
    expect(Object.getPrototypeOf(seen).settings).to.be.undefined
    expect(entry.options.intercept).to.deep.equal({ settings: { namespace: { __jsExpr: 'env.proxy' } } })
  })

  // `intercept` shares the row 2 scope, so the nearest exclusion is the same:
  // a service only the plugin injects must not be readable while resolving it
  it('[row3.neg] keeps the service only the plugin injects out of the intercept scope', async () => {
    const error = root.logger.error
    const logged: any[] = []
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'http',
        name: 'http',
        config: { base: 'http://x' },
      }, {
        id: 'settings',
        name: 'settings',
      }, {
        id: 'gated-neg',
        name: 'needy',
        inject: { settings: true },
        intercept: { settings: { url: { __jsExpr: 'http.base' } } },
      }])
      await sleep()
    } finally {
      ;(root.logger as any).error = error
    }

    const entry = loader.store['gated-neg']
    expect(entry.disabled).to.equal(true)
    expect(entry.intercept).to.be.undefined
    expect(needy.mock.calls).to.have.length(0)
    expect(logged).to.have.length(1)
    expect(String(logged[0][0])).to.match(/cannot get property "http" without inject|http is not defined/)
  })

  it('resolves a literal intercept without a gate', async () => {
    await loader.read([{
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      intercept: { settings: { namespace: 'p2' } },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.undefined
    expect(seen.settings).to.deep.equal({ namespace: 'p2' })
  })

  // a literal `disabled` already decides the entry, so nothing has to wait for
  // a dependency: the intercept is resolved in the parent scope and no
  // coordinator is created
  it('needs no gate for an intercept under a literal disabled', async () => {
    let applied = 0
    loader.mock('literal', () => { applied++ })
    await loader.read([{
      id: 'settings',
      name: 'settings',
    }, {
      id: 'literal',
      name: 'literal',
      inject: { settings: true },
      disabled: true,
      intercept: { settings: { namespace: { __jsExpr: '"p3"' } } },
    }])
    await sleep()

    const entry = loader.store.literal
    expect(entry.gate).to.be.undefined
    expect(entry.disabled).to.equal(true)
    expect(applied).to.equal(0)
  })

  it('re-evaluates an active gate intercept in place', async () => {
    await loader.read([{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, {
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { env: true, settings: true },
      disabled: { __jsExpr: '!env.proxy' },
      intercept: { settings: { namespace: { __jsExpr: 'env.proxy' } } },
    }])
    await sleep()

    const entry = loader.store.worker
    const fiber = entry.fiber
    expect(entry.gate).to.be.ok
    expect(seen.settings).to.deep.equal({ namespace: 'p1' })

    await loader.update('worker', {
      intercept: { settings: { namespace: { __jsExpr: 'env.proxy + "!"' } } },
    })
    await sleep()

    // the table is read on every lookup, so the plugin does not reload
    expect(entry.fiber).to.equal(fiber)
    expect(seen.settings).to.deep.equal({ namespace: 'p1!' })
  })

  it('clears the table when the intercept is removed', async () => {
    await loader.read([{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, {
      id: 'settings',
      name: 'settings',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { env: true, settings: true },
      disabled: { __jsExpr: '!env.proxy' },
      intercept: { settings: { namespace: { __jsExpr: 'env.proxy' } } },
    }])
    await sleep()

    const entry = loader.store.worker
    const fiber = entry.fiber
    expect(seen.settings).to.deep.equal({ namespace: 'p1' })

    // the same table is swapped empty, so this is not a reload either
    await loader.update('worker', { intercept: null })
    await sleep()

    expect(entry.intercept).to.be.undefined
    expect(seen.settings).to.be.undefined
    expect(entry.fiber).to.equal(fiber)
  })

  // a realm reassignment patches the context again, and the table it installs
  // has to be the resolved one
  it('keeps the resolved table when the context is patched', async () => {
    await loader.read([{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, {
      id: 'outer',
      name: '@cordisjs/plugin-group',
      group: true,
      isolate: { settings: true },
      config: [{
        id: 'inner-settings',
        name: 'settings',
      }, {
        id: 'worker',
        name: 'worker',
        inject: { env: true, settings: true },
        disabled: { __jsExpr: '!env.proxy' },
        intercept: { settings: { namespace: { __jsExpr: 'env.proxy' } } },
      }],
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.intercept).to.deep.equal({ settings: { namespace: 'p1' } })
    expect(seen.settings).to.deep.equal({ namespace: 'p1' })

    await loader.update('worker', { config: { a: 1 } })
    await sleep()

    expect(seen.settings).to.deep.equal({ namespace: 'p1' })
  })

  // a refresh that throws leaves the table that is already installed
  it('keeps the previous table when the new intercept throws', async () => {
    const data = (intercept: any) => [{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, {
      id: 'worker',
      name: 'worker',
      inject: { env: true },
      intercept,
    }]
    await loader.read(data({ env: { __jsExpr: 'env.proxy' } }))
    await sleep()

    const entry = loader.store.worker
    expect(entry.intercept).to.deep.equal({ env: 'p1' })
    const fiber = entry.fiber

    await loader.read(data({ env: { __jsExpr: 'nope.proxy' } }))
    await sleep()

    expect(entry.intercept).to.deep.equal({ env: 'p1' })
    // the plugin is not reloaded: intercept is a table, read on every lookup
    expect(entry.fiber).to.equal(fiber)
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
  })

  it('does not evaluate intercept when the entry is disabled', async () => {
    const logged: any[] = []
    const orig = (root.logger as any).error
    ;(root.logger as any).error = (...args: any[]) => logged.push(args)
    try {
      await loader.read([{
        id: 'env',
        name: 'env',
        config: { proxy: 'p1' },
      }, {
        id: 'disabled-worker',
        name: 'worker',
        inject: { env: true },
        disabled: { __jsExpr: 'true' },
        // an expression that cannot resolve: evaluating it would report a failure
        intercept: { env: { __jsExpr: 'nonexistent.service' } },
      }])
      await sleep()

      const entry = loader.store['disabled-worker']
      // the entry is disabled, so `intercept` is neither resolved nor applied
      expect(entry.intercept).to.be.undefined
      expect(logged).to.have.length(0)
    } finally {
      ;(root.logger as any).error = orig
    }
  })
})

// a nested entry resolves its own scope the same way: the parent scope comes
// from the enclosing groups, the entry inject from the entry itself
describe('Loader: nested entry scope', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('env', (ctx: Context, config: any) => {
      ctx.provide('env', { ...config })
    })
    loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    worker = loader.mock('worker', () => {})
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  it('reads the enclosing group scope and its own inject', async () => {
    await loader.read([{
      id: 'env',
      name: 'env',
      config: { workerEnabled: true },
    }, {
      id: 'settings',
      name: 'settings',
      config: { workerEnabled: true },
    }, {
      id: 'outer',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['env'],
      config: [{
        id: 'inner',
        name: '@cordisjs/plugin-group',
        group: true,
        config: [{
          id: 'worker',
          name: 'worker',
          inject: { settings: true },
          // both must be readable: `env` through the enclosing group, `settings`
          // through the entry's own inject
          disabled: { __jsExpr: '!settings.workerEnabled || !env.workerEnabled' },
        }],
      }],
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.inject).to.deep.equal({ settings: true })
    expect(entry.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)
  })

  it('follows the enclosing group when its dependency goes away', async () => {
    const config = (envDisabled?: boolean) => [{
      id: 'env',
      name: 'env',
      config: { workerEnabled: true },
      ...envDisabled ? { disabled: true } : {},
    }, {
      id: 'settings',
      name: 'settings',
      config: { workerEnabled: true },
    }, {
      id: 'outer',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['env'],
      config: [{
        id: 'inner',
        name: '@cordisjs/plugin-group',
        group: true,
        config: [{
          id: 'worker',
          name: 'worker',
          inject: { settings: true },
          disabled: { __jsExpr: '!settings.workerEnabled || !env.workerEnabled' },
        }],
      }],
    }]

    // start from an empty tree so the counts below belong to this tree alone
    await loader.read([])
    await sleep()
    await loader.read(config())
    await sleep()
    expect(loader.store.worker.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)

    // `env` is declared by the enclosing group, so the group owns that
    // dependency: losing it takes the whole subtree down
    await loader.read(config(true))
    await sleep()
    expect(worker.mock.calls).to.have.length(1)

    await loader.read(config())
    await sleep()
    expect(loader.store.worker.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('takes a gated child down with its group', async () => {
    const config = (groupDisabled = false) => [{
      id: 'settings',
      name: 'settings',
      config: { workerEnabled: true },
    }, {
      id: 'outer',
      name: '@cordisjs/plugin-group',
      group: true,
      ...groupDisabled ? { disabled: true } : {},
      config: [{
        id: 'worker',
        name: 'worker',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }],
    }]

    await loader.read([])
    await sleep()
    await loader.read(config())
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)

    // the group's verdict reaches a child that has a gate of its own
    await loader.update('outer', { disabled: true })
    await sleep()

    expect(entry.disabled).to.equal(true)
    expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)

    await loader.update('outer', { disabled: null })
    await sleep()

    // the child rebuilds its gate in the scope that is enabled again
    expect(loader.store.worker.disabled).to.equal(false)
    expect(loader.store.worker.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })
})

// dependency-driven teardown is not the entry disabling itself, and the entry
// must come back when the dependency does
describe('Loader: entry scope lifecycle', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('provider', (ctx: Context) => {
      ctx.provide('settings', { workerEnabled: true })
    })
    worker = loader.mock('worker', () => {})
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  // a teardown the entry did not ask for must not land here
  const writeBacks = () => loader.changes.filter(change => {
    return change.id === 'worker' && change.options?.disabled === true
  })

  // the epoch tracks the service binding, not the value inside it: an ordinary
  // mutation of a provided object is not a new binding
  it('does not re-evaluate when a service field is mutated', async () => {
    let state: any
    loader.mock('holder', (ctx: Context) => {
      state = { enabled: true }
      ctx.provide('flip', state)
    })
    const mirror = loader.mock('mirror', () => {})
    await loader.read([{
      id: 'holder',
      name: 'holder',
    }, {
      id: 'mirror',
      name: 'mirror',
      inject: { flip: true },
      disabled: { __jsExpr: '!flip.enabled' },
    }])
    await sleep()

    const entry = loader.store.mirror
    expect(mirror.mock.calls).to.have.length(1)
    expect(entry.disabled).to.equal(false)

    state.enabled = false
    await sleep()

    expect(mirror.mock.calls).to.have.length(1)
    expect(entry.disabled).to.equal(false)
  })

  it('keeps the dependency and drops the plugin when it goes away', async () => {
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.disabled).to.equal(false)
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)

    // drop the provider: the gate loses its dependency and takes the plugin
    // fiber down, without writing `disabled: true` back to the options
    await loader.update('provider', { disabled: true })
    await sleep()

    expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
    expect(entry.options.disabled).to.deep.equal({ __jsExpr: '!settings.workerEnabled' })
    expect(writeBacks()).to.have.length(0)

    // and it comes back once the dependency does
    await loader.update('provider', { disabled: null })
    await sleep()

    expect(entry.disabled).to.equal(false)
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(2)
  })

  it('re-evaluates once per dependency transition', async () => {
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    const gate = entry.gate
    const before = worker.mock.calls.length
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)

    for (let i = 0; i < 3; i++) {
      await loader.update('provider', { disabled: true })
      await sleep()
      expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)

      await loader.update('provider', { disabled: null })
      await sleep()
      expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
    }

    // one apply per transition, and the coordinator is reused throughout
    expect(worker.mock.calls).to.have.length(before + 3)
    expect(entry.gate).to.equal(gate)
  })

  // the open question in the issue: an entry with no `inject` needs no second
  // fiber, and gaining or losing its `inject` is a rebuild, not a mutation
  it('adds and drops the coordinator with the entry inject', async () => {
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'worker',
      name: 'worker',
    }])
    await sleep()

    expect(loader.store.worker.gate).to.be.undefined
    expect(worker.mock.calls).to.have.length(1)

    await loader.update('worker', {
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    })
    await sleep()

    const gated = loader.store.worker
    expect(gated.gate).to.be.ok
    expect(gated.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(2)
    // the rebuild took the old fiber down; that is not the entry disabling
    // itself, so nothing may be written back to the options
    expect(writeBacks()).to.have.length(0)

    await loader.update('worker', { inject: null, disabled: null })
    await sleep()

    expect(loader.store.worker.gate).to.be.undefined
    expect(worker.mock.calls).to.have.length(3)
  })

  it('fetches the module while the dependencies are still settling', async () => {
    // a fresh name, so the fetch is not already cached by an earlier test
    loader.mock('lazy', () => {})
    const fetched: string[] = []
    const original = loader.import.bind(loader)
    loader.import = ((name: string) => {
      fetched.push(name)
      return original(name)
    }) as any
    try {
      await loader.read([{
        id: 'lazy',
        name: 'lazy',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }])
      await sleep()

      const entry = loader.store.lazy
      expect(entry.gate!.state).to.equal(FiberState.PENDING)
      expect(entry.fiber).to.be.undefined
      // a dependency constrains activation, not the fetch
      expect(fetched).to.include('lazy')
    } finally {
      loader.import = original as any
    }
  })

  it('takes down the fiber the entry points at when the dependency goes away', async () => {
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)

    // what HMR does: a replacement is instantiated and the entry points at it.
    // It is created outside the entry, so it does not inherit the entry inject
    // and only the gate can take it down.
    const replacement = loader.context.registry.plugin(() => {}, undefined, () => [])
    entry.fiber = replacement
    await sleep()
    expect(replacement.state).to.equal(FiberState.ACTIVE)

    await loader.update('provider', { disabled: true })
    await sleep()

    expect(replacement.state).to.equal(FiberState.DISPOSED)
  })

  it('drops a pending gate with its entry', async () => {
    await loader.read([{
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate).to.be.ok
    expect(entry.gate!.state).to.equal(FiberState.PENDING)
    expect(worker.mock.calls).to.have.length(0)

    loader.remove('worker')
    await sleep()

    expect(loader.store.worker).to.be.undefined
    expect([...loader.entries()]).to.have.length(0)
  })

  it('keeps one coordinator across an update', async () => {
    await loader.read([{
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.worker
    const gate = entry.gate
    expect(gate!.state).to.equal(FiberState.PENDING)

    await loader.update('worker', { config: { a: 1 } })
    await sleep()

    // the pending gate keeps coordinating; a second one would wait forever
    expect(entry.gate).to.equal(gate)
    expect(entry.gate!.state).to.equal(FiberState.PENDING)
  })

  // the reload log is decided by the same leaf guard as the config: a gated
  // entry's plugin fiber is the coordinator's child, and reading that as a
  // nested plugin would drop the log the entry used to produce
  it('logs a reload for a gated entry', async () => {
    loader.mock('gated-worker', () => {})
    await loader.read([
      { id: 'worker', name: 'worker', config: { a: 1 } },
      { id: 'provider', name: 'provider' },
      { id: 'gated-worker', name: 'gated-worker', inject: { settings: true }, disabled: { __jsExpr: 'false' }, config: { a: 1 } },
    ])
    await sleep()

    loader.enableLogs = true
    const logger = root.logger as any
    const before = logger.buffer.length
    try {
      await loader.update('worker', { config: { a: 2 } })
      await loader.update('gated-worker', { config: { a: 2 } })
      await sleep()

      const names = logger.buffer.slice(before)
        .filter((message: any) => message.name === 'loader' && message.args?.[1] === 'reload')
        .map((message: any) => message.args[2])
      expect(names).to.deep.equal(['worker', 'gated-worker'])
    } finally {
      loader.enableLogs = false
    }
  })

  // a literal `disabled` has nothing to evaluate, so it settles without a gate
  it('settles a literal disabled without a coordinator', async () => {
    const plain = loader.mock('plain', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'plain',
      name: 'plain',
      inject: { settings: true },
      disabled: true,
    }])
    await sleep()

    const entry = loader.store.plain
    expect(entry.gate).to.be.undefined
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber).to.be.undefined
    expect(plain.mock.calls).to.have.length(0)
  })

  // a dependency-driven reload is not driven by any entry update, so the tree's
  // task list is the only thing that can wait for it
  it('waits for a coordinator that is still loading', async () => {
    const gated = loader.mock('gated', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'gated',
      name: 'gated',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.gated
    expect(gated.mock.calls).to.have.length(1)

    const original = loader.import.bind(loader)
    loader.import = (async (name: string) => {
      await sleep(20)
      return original(name)
    }) as any
    try {
      // the provider re-registers its value, which reloads the coordinator;
      // its fetch is still in flight when the update returns
      await loader.update('provider', { config: { workerEnabled: true } })
      await loader.await()
      expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
      expect(gated.mock.calls).to.have.length(2)
    } finally {
      loader.import = original as any
    }
  })

  // the verdict is the coordinator's to decide, so a change to the option that
  // feeds it has to go through a new coordinator
  it('rebuilds the coordinator when the disabled option changes', async () => {
    const sw = loader.mock('sw', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'sw',
      name: 'sw',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.sw
    const gate = entry.gate
    expect(sw.mock.calls).to.have.length(1)

    await loader.update('sw', { disabled: { __jsExpr: 'true' } })
    await sleep()

    expect(entry.gate).to.not.equal(gate)
    expect(entry.gate!.state).to.equal(FiberState.ACTIVE)
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
    expect(sw.mock.calls).to.have.length(1)
  })

  // a load that failed must not pin the entry: the next update tries again
  it('retries a failed load on the next update', async () => {
    const flaky = loader.mock('flaky', () => {})
    const original = loader.import.bind(loader)
    let attempts = 0
    loader.import = (async (name: string) => {
      if (name === 'flaky' && !attempts++) throw new Error('boom')
      return original(name)
    }) as any
    try {
      await loader.read([{
        id: 'provider',
        name: 'provider',
      }, {
        id: 'flaky',
        name: 'flaky',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }])
      await sleep()

      const entry = loader.store.flaky
      expect(attempts).to.equal(1)
      expect(entry.fiber).to.be.undefined
      expect(flaky.mock.calls).to.have.length(0)

      // a coordinator whose load failed cannot retry on its own, so the update
      // replaces it
      const failed = entry.gate
      expect(failed!.state).to.equal(FiberState.ACTIVE)

      // the failed fetch is not cached, and the failed coordinator is replaced
      await loader.update('flaky', { config: { a: 1 } })
      await sleep()

      expect(attempts).to.equal(2)
      expect(flaky.mock.calls).to.have.length(1)
      expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)
      // the coordinator it replaces is gone rather than left waiting
      expect(entry.gate).to.not.equal(failed)
      expect(failed!.state).to.equal(FiberState.DISPOSED)
    } finally {
      loader.import = original as any
    }
  })

  // the early fetch is shared with the load, but a failure must not be reused
  it('fetches again when the module was unavailable at first', async () => {
    const late = loader.mock('late', () => {})
    const original = loader.import.bind(loader)
    let attempts = 0
    let available = false
    loader.import = (async (name: string) => {
      if (name === 'late' && !available) {
        attempts++
        throw new Error('not yet')
      }
      return original(name)
    }) as any
    try {
      // the dependency is missing, so the coordinator starts the fetch and waits
      await loader.read([{
        id: 'late',
        name: 'late',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }])
      await sleep()

      const entry = loader.store.late
      expect(entry.gate!.state).to.equal(FiberState.PENDING)
      expect(attempts).to.equal(1)

      // the module appears before the dependency does
      available = true
      await loader.read([{
        id: 'provider',
        name: 'provider',
      }, {
        id: 'late',
        name: 'late',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }])
      await sleep()

      expect(entry.gate!.state).to.equal(FiberState.ACTIVE)
      expect(late.mock.calls).to.have.length(1)
    } finally {
      loader.import = original as any
    }
  })

  // the coordinator's teardown takes the plugin fiber down from inside its own
  // teardown: the counter has to cover both while either is in flight, or the
  // write-back would take a teardown the loader performed for a self-dispose
  it('keeps a nested teardown counted', async () => {
    const seen: number[] = []
    let slow: any
    loader.mock('slow', async function* (ctx: Context) {
      slow = ctx.fiber.entry
      yield async () => {
        seen.push(slow._disposing)
        await sleep(10)
        seen.push(slow._disposing)
      }
    })
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'slow',
      name: 'slow',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.slow
    expect(entry.fiber!.state).to.equal(FiberState.ACTIVE)

    await loader.remove('slow')
    await sleep(30)

    expect(seen).to.deep.equal([2, 2])
    expect(slow._disposing).to.equal(0)
    expect(loader.changes.filter(change => {
      return change.id === 'slow' && change.options?.disabled === true
    })).to.have.length(0)
  })

  // an inject value is part of the entry's identity: one that cannot be
  // resolved means the entry does not run
  it('reports a failing inject value as a verdict', async () => {
    const failing = loader.mock('failing', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'failing',
      name: 'failing',
      // `env` is provided nowhere, so resolving the value has to throw
      inject: { settings: { namespace: { __jsExpr: 'env.namespace' } } },
    }])
    await sleep()

    const entry = loader.store.failing
    expect(Object.keys(entry.inject)).to.have.length(0)
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber).to.be.undefined
    expect(failing.mock.calls).to.have.length(0)
  })

  // a failure inside the coordinator is a verdict, not a stuck state
  it('reports a failing expression under a coordinator as a verdict', async () => {
    const broken = loader.mock('broken', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'broken',
      name: 'broken',
      inject: { settings: true },
      disabled: { __jsExpr: 'nope.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.broken
    // the coordinator stays loaded so the next trigger re-evaluates it
    expect(entry.gate!.state).to.equal(FiberState.ACTIVE)
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber).to.be.undefined
    expect(broken.mock.calls).to.have.length(0)
  })

  // `refresh` is for an entry that has nothing yet; a coordinator already
  // covers it
  it('does nothing while a coordinator is still waiting', async () => {
    const pending = loader.mock('pending', () => {})
    await loader.read([{
      id: 'pending',
      name: 'pending',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    }])
    await sleep()

    const entry = loader.store.pending
    const gate = entry.gate
    expect(gate.state).to.equal(FiberState.PENDING)
    await entry.refresh()
    await sleep()

    expect(entry.gate).to.equal(gate)
    expect(pending.mock.calls).to.have.length(0)
  })

  // `refresh` re-evaluates an entry that has nothing yet: a second pass over a
  // loaded entry would create a second plugin fiber for the same options
  it('does nothing for an entry that already has a fiber', async () => {
    await loader.read([{ id: 'worker', name: 'worker' }])
    await sleep()

    const entry = loader.store.worker
    const fiber = entry.fiber
    expect(fiber!.state).to.equal(FiberState.ACTIVE)

    await entry.refresh()
    await sleep()

    expect(entry.fiber).to.equal(fiber)
    expect(worker.mock.calls).to.have.length(1)
  })

  // the values are part of the entry's identity: an entry whose inject stopped
  // resolving must not fall back to an empty scope and run without it
  it('does not start an entry whose values still cannot be resolved', async () => {
    const unresolved = loader.mock('unresolved', () => {})
    await loader.read([{
      id: 'provider',
      name: 'provider',
    }, {
      id: 'unresolved',
      name: 'unresolved',
      // `env` is provided nowhere, so resolving the value has to throw
      inject: { settings: { namespace: { __jsExpr: 'env.namespace' } } },
    }])
    await sleep()

    const entry = loader.store.unresolved
    expect(entry.fiber).to.be.undefined
    await entry.refresh()
    await sleep()

    expect(entry.disabled).to.equal(true)
    expect(entry.fiber).to.be.undefined
    expect(unresolved.mock.calls).to.have.length(0)
  })

  // the context patch is awaited before anything is created, so a hook that
  // removes the entry must not leave a fiber behind for it
  it('reports an entry that disposed itself as disabled', async () => {
    const suicide = loader.mock('suicide', (ctx: Context) => {
      ctx.fiber.dispose()
    })
    await loader.read([{ id: 'suicide', name: 'suicide' }])
    await sleep()

    const entry = loader.store.suicide
    // the write-back turned the option into a literal, so the verdict has to
    // follow it rather than keep the value it settled on
    expect(entry.options.disabled).to.equal(true)
    expect(entry.disabled).to.equal(true)
    expect(suicide.mock.calls).to.have.length(1)
  })

  it('reports a gated entry that disposed itself as disabled', async () => {
    loader.mock('env2', (ctx: Context) => ctx.provide('env2', {}))
    const suicide = loader.mock('gated-suicide', (ctx: Context) => {
      ctx.fiber.dispose()
    })
    await loader.read([{
      id: 'env2',
      name: 'env2',
    }, {
      id: 'gated-suicide',
      name: 'gated-suicide',
      inject: { env2: true },
      disabled: { __jsExpr: 'false' },
    }])
    await sleep()

    const entry = loader.store['gated-suicide']
    // the gate makes the plugin a child of it, but the write-back still lands on
    // the entry: the leaf guard treats the gate's child as the root fiber
    expect(entry.gate).to.be.ok
    expect(entry.options.disabled).to.equal(true)
    expect(entry.disabled).to.equal(true)
    expect(suicide.mock.calls).to.have.length(1)
  })

  it('creates nothing for an entry removed while its context is patched', async () => {
    const orphan = loader.mock('orphan', () => {})
    const dispose = root.on('loader/patch-context', (entry: any, next: any) => {
      if (entry.options.id === 'orphan') loader.root.remove('orphan')
      return next()
    })
    try {
      await loader.read([{
        id: 'provider',
        name: 'provider',
      }, {
        id: 'orphan',
        name: 'orphan',
        inject: { settings: true },
        disabled: { __jsExpr: '!settings.workerEnabled' },
      }])
      await sleep()
    } finally {
      dispose()
    }

    // the coordinator is registered under its own runtime, so count by owner
    const leftovers: any[] = []
    for (const runtime of loader.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.entry?.options?.id === 'orphan') leftovers.push(fiber)
      }
    }
    expect(loader.store.orphan).to.be.undefined
    expect(leftovers).to.have.length(0)
    expect(orphan.mock.calls).to.have.length(0)
  })

  // the fetch is the other await point before a fiber exists
  it('creates nothing for an entry removed while its module is fetched', async () => {
    const delayed = loader.mock('delayed', () => {})
    const original = loader.import.bind(loader)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const reached = new Promise<void>((resolve) => { entered = resolve })
    loader.import = (async (name: string) => {
      if (name === 'delayed') {
        entered()
        await held
      }
      return original(name)
    }) as any
    try {
      const reading = loader.read([{ id: 'delayed', name: 'delayed' }])
      await reached
      loader.root.remove('delayed')
      release()
      await reading
      await sleep()
    } finally {
      loader.import = original as any
    }

    const leftovers: any[] = []
    for (const runtime of loader.ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.entry?.options?.id === 'delayed') leftovers.push(fiber)
      }
    }
    expect(loader.store.delayed).to.be.undefined
    expect(leftovers).to.have.length(0)
    expect(delayed.mock.calls).to.have.length(0)
  })
})

// the entry injection scope is the parent scope plus the entry inject, so a
// move changes it even when none of the entry's own fields changed
describe('Loader: entry scope follows a move', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('settings', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    worker = loader.mock('worker', () => {})
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  const group = (id: string, enabled: boolean) => ({
    id,
    name: '@cordisjs/plugin-group',
    group: true,
    isolate: { settings: true },
    config: [{ id: `${id}-settings`, name: 'settings', config: { workerEnabled: enabled } }],
  })

  const withWorker = (target: string) => {
    const tree = [group('a', true), group('b', false)] as any[]
    const host = tree.find(item => item.id === target)
    host.config.push({
      id: 'worker',
      name: 'worker',
      inject: { settings: true },
      disabled: { __jsExpr: '!settings.workerEnabled' },
    })
    return tree
  }

  it('re-evaluates disabled in the scope it moved to', async () => {
    await loader.read([])
    await sleep()
    await loader.read(withWorker('a'))
    await sleep()

    const entry = loader.store.worker
    expect(entry.disabled).to.equal(false)
    expect(worker.mock.calls).to.have.length(1)

    // the same entry, adopted by a group whose `settings` disables it
    await loader.update('worker', {}, 'b')
    await sleep()

    expect(loader.store.worker).to.equal(entry)
    expect(entry.disabled).to.equal(true)
    expect(entry.fiber?.state).to.not.equal(FiberState.ACTIVE)
  })
})

// a gate that is still waiting has no scope to evaluate in, so it holds the
// options it will read once its dependencies arrive
describe('Loader: pending gate', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any
  let seen: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('env', (ctx: Context, config: any) => {
      ctx.provide('env', { ...config })
    })
    worker = loader.mock('worker', (ctx: Context) => {
      seen = ctx[Context.intercept]
    })
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  it('applies the intercept it holds when the dependencies arrive', async () => {
    const workerEntry = (intercept: any) => [{
      id: 'worker',
      name: 'worker',
      inject: { env: true },
      disabled: { __jsExpr: '!env.proxy' },
      intercept,
    }]

    await loader.read(workerEntry({ env: { tag: { __jsExpr: 'env.proxy' } } }))
    await sleep()

    const entry = loader.store.worker
    expect(entry.gate!.state).to.equal(FiberState.PENDING)
    expect(entry.intercept).to.be.undefined
    // an undecided verdict is not an enabled entry
    expect(entry.disabled).to.equal(true)

    await loader.update('worker', { intercept: { env: { tag: 'late' } } })
    await sleep()

    // nothing to evaluate against yet, and the plugin has not started
    expect(entry.gate!.state).to.equal(FiberState.PENDING)
    expect(entry.intercept).to.be.undefined
    expect(worker.mock.calls).to.have.length(0)

    await loader.read([{
      id: 'env',
      name: 'env',
      config: { proxy: 'p1' },
    }, ...workerEntry({ env: { tag: 'late' } })])
    await sleep()

    expect(loader.store.worker).to.equal(entry)
    expect(worker.mock.calls).to.have.length(1)
    expect(seen.env).to.deep.equal({ tag: 'late' })
  })
})

// a group is structural: it is created even when its own options disable it,
// and only its children are held back
describe('Loader: group verdict', () => {
  const root = new Context()

  let loader!: MockLoader
  let worker!: any

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('provider', (ctx: Context, config: any) => {
      ctx.provide('settings', { ...config })
    })
    worker = loader.mock('worker', () => {})
  })

  beforeEach(() => {
    worker.mock.resetCalls()
  })

  const config = (groupEnabled: boolean) => [{
    id: 'provider',
    name: 'provider',
    config: { groupEnabled },
  }, {
    id: 'outer',
    name: '@cordisjs/plugin-group',
    group: true,
    inject: ['settings'],
    disabled: { __jsExpr: '!settings.groupEnabled' },
    config: [{ id: 'worker', name: 'worker' }],
  }]

  it('creates a disabled group and holds its children back', async () => {
    await loader.read(config(false))
    await sleep()

    const group = loader.store.outer
    expect(group.gate).to.be.ok
    expect(group.disabled).to.equal(false)
    expect(group.fiber!.state).to.equal(FiberState.ACTIVE)
    // the child is an entry, only its plugin is held back
    expect(loader.store.worker).to.be.ok
    expect(loader.store.worker.fiber).to.be.undefined
    expect(worker.mock.calls).to.have.length(0)
  })

  it('brings the children back when the verdict clears', async () => {
    const group = loader.store.outer

    await loader.update('provider', { config: { groupEnabled: true } })
    await sleep()

    // the gate reloaded on the new value and the group kept its expression:
    // a group has no verdict of its own to write back
    expect(group.options.disabled).to.deep.equal({ __jsExpr: '!settings.groupEnabled' })
    expect(group.gate!.state).to.equal(FiberState.ACTIVE)
    expect(worker.mock.calls).to.have.length(1)
    expect(loader.store.worker.fiber!.state).to.equal(FiberState.ACTIVE)
  })

  // the coordinator decides for its own entry, but the verdict the tree reports
  // also includes the enclosing group: a dependency arriving while the group is
  // disabled must not start the plugin
  it('holds a gated child back while the group is disabled', async () => {
    let applied = 0
    loader.mock('gated', () => { applied++ })
    loader.mock('late', (ctx: Context) => {
      ctx.provide('missing', { anything: true })
    })

    await loader.read([{
      id: 'provider',
      name: 'provider',
      config: { groupEnabled: true },
    }, {
      id: 'late',
      name: 'late',
      disabled: true,
    }, {
      id: 'outer',
      name: '@cordisjs/plugin-group',
      group: true,
      inject: ['settings'],
      disabled: { __jsExpr: '!settings.groupEnabled' },
      config: [{
        id: 'gated',
        name: 'gated',
        inject: { missing: true },
        disabled: { __jsExpr: '!missing.anything' },
      }],
    }])
    await sleep()

    // the child waits for its own dependency
    expect(loader.store.gated.gate!.state).to.equal(FiberState.PENDING)
    expect(applied).to.equal(0)

    // the group's verdict flips while the child is still waiting
    await loader.update('provider', { config: { groupEnabled: false } })
    await sleep()

    // the dependency arrives, but the group is still disabled
    await loader.update('late', { disabled: false })
    await sleep()

    expect(loader.store.gated.disabled).to.equal(true)
    expect(applied).to.equal(0)

    await loader.update('provider', { config: { groupEnabled: true } })
    await sleep()

    expect(loader.store.gated.disabled).to.equal(false)
    expect(applied).to.equal(1)
  })
})

# Cordis

[![Codecov](https://img.shields.io/codecov/c/github/shigma/cordis?style=flat-square)](https://codecov.io/gh/shigma/cordis)
[![downloads](https://img.shields.io/npm/dm/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![npm](https://img.shields.io/npm/v/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![GitHub](https://img.shields.io/github/license/shigma/cordis?style=flat-square)](https://github.com/shigma/cordis/blob/master/LICENSE)

AOP Framework for Modern JavaScript Applications.

```ts
import { Context } from 'cordis'

const ctx = new Context()

ctx.plugin(plugin)              // use plugins
ctx.on(event, callback)         // listen to events

ctx.start()                     // start app
```

## Contents

- [Events](#events-)
  - [Listen to events](#listen-to-events-)
  - [Trigger events](#trigger-events-)
  - [Events with `this` argument](#events-with-this-argument-)
  - [Application lifecycle](#application-lifecycle-)
- [Plugin](#plugin-)
  - [Plugin as a module](#plugin-as-a-module-)
  - [Unload a plugin](#unload-a-plugin-)
  - [Clean up side effects](#clean-up-side-effects-)
  - [Reusable plugins](#reusable-plugins-)
- [Service](#service-)
  - [Built-in services](#built-in-services-)
  - [Service as a plugin](#service-as-a-plugin-)
  - [Service dependencies](#service-dependencies-)

## Guide [↑](#contents)

### Context

Contexts provide three kinds of functionality:

- allowing access to services (service container)
- managing states of plugins (plugin context)
- filtering sessions for events (session context)

### Events [↑](#contents)

Cordis has a built-in event model with lifecycle management.

#### Listen to events [↑](#contents)

To add an event listener, simply use `ctx.on()`, which is similar to the `EventEmitter` that comes with Node.js: the first parameter incidates the name of the event and the second parameter is the callback function. We also support similar methods `ctx.once()`, which is used to listen to events only once, and `ctx.off()`, which is used to cancel as event listeners.

```ts
ctx.on('some-event', callback)
ctx.once('some-event', callback)
ctx.off('some-event', callback)
```

One difference between cordis `Context` and Node.js `EventEmitter` is that both `ctx.on()` and `ctx.once()` returns a dispose function, which can be called to cancel the event listener. So you do not actually have to use `ctx.once()` and `ctx.off()`. Here is an example of add a listener that will only be called once:

```ts
const dispose = ctx.on('some-event', (...args) => {
  dispose()
  // do something
})
```

#### Trigger events [↑](#contents)

In cordis, triggering an event can take many forms. Currently we support four methods with some differences between them:

- emit: calling all listeners at the same time
- parallel: the asynchronous version of `emit`
- bail: calling all listeners in the order they were registered; when a value other than `false`, `null` or `undefined` is returned, the value is returned and subsequent listeners will not be called
- serial: the synchronous version of `bail`

The usage of these methods is also similar to `EventEmitter`. The first parameter is the event name, and the following parameters are passed to the listeners. Below is an example:

```ts
ctx.emit('some-event', arg1, arg2, ...rest)
// corresponds to
ctx.on('some-event', (arg1, arg2, ...rest) => {})
```

#### Events with `this` argument [↑](#contents)

A custom `this` argument can be passed to the listeners:

```ts
ctx.emit(thisArg, 'some-event', arg1, arg2, ...rest)
// corresponds to
ctx.on('some-event', function (arg1, arg2, ...rest) {
  // `this` will point to `thisArg`
})
```

An optional symbol `Context.filter` on `this` argument can be used to filter listeners:

```ts
thisArg[Context.filter] = (ctx) => {
  // return truthy to call the listener, falsy to skip the listener
  // if not specified, all listeners will be called
}
```

#### Application lifecycle [↑](#contents)

There are some special events related to the application lifecycle. You can listen to them as if they were normal events, but they are not triggered by `ctx.emit()`.

- `ready`: triggered when the application starts
- `dispose`: triggered when the context is unloaded
- `fork`: trigged every time when the plugin is loaded

The `ready` event is triggered when the application starts. If a `ready` listener is registered in a application that has already started, it will be called immediately. Below is an example:

```ts
ctx.on('ready', async () => {
  await someAsyncWork()
  console.log(1)
})

console.log(2)

// start the application
// trigger the `ready` event
await ctx.start()

ctx.on('ready', () => {
  console.log(3)
})

// output: 2 1 3
```

It is recommended to wrap code in the `ready` event in the following scenarios:

- contains asynchronous operations (for example IO-intensive tasks)
- should be called after other plugins are ready (for exmaple performance checks)

We will talk about `dispose` and `fork` events in the next section.

### Plugin [↑](#contents)

A **plugin** is one of three basic forms:

- a function that accepts two parameters, of which the first is the plugin context, and the second is the provided opions
- a class that accepts above parameters
- an object with an `apply` method in the form of the above function

When a plugin is loaded, it is basically equivalent to calling the above function or class. Therefore, the following four ways of adding a event listener is basically equivalent:

```ts
ctx.on(event, callback)

ctx.plugin(ctx => ctx.on(event, callback))

ctx.plugin({
  apply: ctx => ctx.on(event, callback),
})

ctx.plugin(class {
  constructor(ctx) {
    ctx.on(event, callback)
  }
})
```

It seems that this just changes the way of writing the direct call, but plugins can help us organize complicated logics while managing the options, which can greatly improve code maintainability.

#### Plugin as a module [↑](#contents)

It is recommended to write plugins as modules, specifically, as [default exports](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import#default_import) or [namespace exports](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import#namespace_import).

```ts
// foo.ts (default export)
export default class Foo {
  constructor(ctx) {}
}
```

```ts
// bar.ts (namespace export)
// it is also recommended to export a `name` in this case
export const name = 'bar'

export function apply(ctx) {}
```

```ts
// index.ts
import Foo from './foo'
import * as Bar from './bar'

ctx.plugin(Foo)
ctx.plugin(Bar)
```

#### Unload a plugin [↑](#contents)

`ctx.plugin()` returns a `Fork` instance. To unload a plugin, we can use the `dispose()` method of it:

```ts
// load a plugin
const fork = ctx.plugin((ctx) => {
  ctx.on(event1, callback1)
  ctx.on(event2, callback2)
  ctx.on(event3, callback3)
})

// unload the plugin, removing all listeners
fork.dispose()
```

Some plugins can be loaded multiple times. To unload every forks of a plugin without access to the `Fork` instance, we can use `ctx.registry`:

```ts
// remove all forks of the plugin
// return true if the plugin is active
ctx.registry.delete(plugin)
```

#### Clean up side effects [↑](#contents)

The `dispose` event is triggered when the context is unloaded. It can be used to clean up plugins' side effects. 

Most of the built-in methods of `Context` are already implemented to be disposable (including `ctx.on()` and `ctx.plugin()`), so you do not need to handle these side effects manually. However, if some side effects are introduced by other means, a `dispose` listener is necessary.

Below is an example:

```ts
// an example server plugin
export function apply(ctx) {
  const server = createServer()

  ctx.on('ready', () => {
    // start the server
    server.listen(80)
  })

  ctx.on('dispose', () => {
    // clean up the side effect
    server.close()
  })
}
```

In this example, without the `dispose` event, the port `80` will still be occupied after the plugin is unloaded. If the plugin is loaded a second time, the server will fail to start.

#### Reusable plugins [↑](#contents)

By default, a plugin is loaded only once. If we want to create a reusable plugin, we can use the `fork` event:

```ts
// an example reusable plugin
function callback(ctx, config) {
  console.log('outer', config.value)

  ctx.on('fork', (ctx, config) => {
    console.log('inner', config.value)
  })
}

// outer foo
// inner foo
ctx.plugin(callback, { value: 'foo' })

// inner bar
ctx.plugin(callback, { value: 'bar' })
```

Note that the `fork` listener itself is a plugin function. You can also listen to `dispose` event inside `fork` listeners, which serves a different purpose: the inner `dispose` listener is called when the fork is unloaded, while the outer `dispose` listener is called when the whole plugin is unloaded (either via `ctx.registry.delete()` or when all forks are unloaded).

```ts
// an example reusable plugin
function callback(ctx) {
  ctx.on('dispose', () => {
    console.log('outer dispose')
  })

  ctx.on('fork', (ctx) => {
    ctx.on('dispose', () => {
      console.log('inner dispose')
    })
  })
}

const fork1 = ctx.plugin(callback)
const fork2 = ctx.plugin(callback)

// inner dispose
fork1.dispose()

// inner dispose
// outer dispose
fork2.dispose()
```

Also, you should never use methods from the outer `ctx` parameter because they are not bound to the fork and cannot be cleaned up when the fork is disposed. Instead, simply use the `ctx` parameter of the `fork` listener.

### Service [↑](#contents)

A **service** is an object that can be accessed by multiple contexts. Most of the contexts' functionalities come from services.

For ones who are familiar with IoC / DI, services provide an IoC (inversion of control), but is not implemented through DI (dependency injection). Cordis provides easy access to services within the context through TypeScript's unique mechanism of declaration merging.

#### Built-in services [↑](#contents)

Cordis has four built-in services:

- `ctx.events`: event model and lifecycle
- `ctx.registry`: plugin management
- `ctx.root`: the root context
- `ctx.state`: the current plugin fork

You can access to these services from any contexts.

#### Service as a plugin [↑](#contents)

Custom services can be loaded as plugins. To create a service plugin, simply derive a class from `Service`:

```ts
import { Service } from 'cordis'

class CustomService extends Service {
  constructor(ctx) {
    super(ctx, 'custom', true)
  }

  method() {
    // do something
  }
}
```

The second parameter of the constructor is the service name. After loading the service plugin, we can access the custom service through `ctx.custom`:

```ts
ctx.plugin(CustomService)
ctx.custom.method()
```

The third parameter of the constructor is a boolean value of whether the service is immediately available. If it is `false` (by default), the service will only be available after the application is started.

There are also some abstract methods for lifecycle events:

```ts
class CustomService extends Service {
  constructor(ctx) {
    super(ctx, 'custom', true)
  }

  // `ready` listener
  start() {}
  // `dispose` listener
  stop() {}
  // `fork` listener
  fork() {}
}
```

#### Service dependencies [↑](#contents)

Some plugins may depend on certain services. For example, supposing we have a service called `database`, and we want to use it in a plugin:

```ts
// my-plugin.ts
export function apply(ctx) {
  // fetch data from the database
  ctx.database.get(table, id)
}
```

Trying to load this plugin is likely to result in an error because `ctx.database` may be `undefined` when the plugin is loaded. To make sure that the plugin is loaded after the service is available, we can use a special property called `using`:

```ts
// my-plugin.ts
export const using = ['database']

export function apply(ctx) {
  // fetch data from the database
  ctx.database.get(table, id)
}
```

```ts
// for class plugins, use static property
export default class MyPlugin {
  static using = ['database']

  constructor(ctx) {
    // fetch data from the database
    ctx.database.get(table, id)
  }
}
```

`using` is a list of service dependencies. If a service is a dependency of a plugin, it means:

- the plugin will not be loaded until the service becomes truthy
- the plugin will be unloaded as soon as the service changes
- if the changed value is still truthy, the plugin will be reloaded

For plugins whose functions depend on a service, we also provide a syntactic sugar `ctx.using()`:

```ts
ctx.using(['database'], (ctx) => {
  ctx.database.get(table, id)
})

// equivalent to
ctx.plugin({
  using: ['database'],
  apply: (ctx) => {
    ctx.database.get(table, id)
  },
})
```

## API

### Context

#### ctx.extend(meta)

- meta: `Partial<Context.Meta>` additional properties
- returns: `Context`

Create a new context with the current context as the prototype. Properties specified in `meta` will be assigned to the new context.

#### ctx.isolate(keys)

- keys: `string[]` service names
- returns: `Context`

Create a new context with the current context as the prototype. Services included in `keys` will be isolated in the new context, while services not included in `keys` are still shared with the parent context.

```ts
const root = new Context()
const ctx1 = root.isolate(['foo'])
const ctx2 = root.isolate(['bar'])

root.foo = { value: 1 }
ctx1.foo                        // undefined
ctx2.foo                        // { value: 1 }

ctx1.bar = { value: 2 }
root.bar                        // { value: 2 }
ctx2.bar                        // undefined
```

### Events

`ctx.events` is a built-in service of event model and lifecycle. Most of its methods are also directly accessible in the context.

#### ctx.emit(thisArg?, event, ...param)

- thisArg: `object` binding object
- event: `string` event name
- param: `any[]` event parameters
- returns: `void`

Trigger the event called `event`, calling all associated listeners **synchronously** at the same time, passing the supplied arguments to each. If the first argument is an object, it will be used as `this` when executing each listener.

<!-- An [`internal/warn`](#internalwarn) event is triggered if a listener throws an error or returns a rejected promise. -->

#### ctx.parallel(thisArg?, event, ...param)

- thisArg: `object` binding object
- event: `string` event name
- param: `any[]` event parameters
- returns: `Promise<void>`

Trigger the event called `event`, calling all associated listeners **asynchronously** at the same time, passing the supplied arguments to each. If the first argument is an object, it will be used as `this` when executing each listener.

<!-- An [`internal/warn`](#internalwarn) event is triggered if a listener throws an error or returns a rejected promise. -->

#### ctx.bail(thisArg?, event, ...param)

- thisArg: `object` binding object
- event: `string` event name
- param: `any[]` event parameters
- returns: `any`

Trigger the event called `event`, calling all associated listeners **synchronously** in the order they were registered, passing the supplied arguments to each. If the first argument is an object, it will be used as `this` when executing each listener.

If any listener returns a value other than `false`, `null` or `undefined`, that value is returned. If all listeners return `false`, `null` or `undefined`, an `undefined` is returned. In either case, subsequent listeners will not be called.

#### ctx.serial(thisArg?, event, ...param)

- thisArg: `object` binding object
- event: `string` event name
- param: `any[]` event parameters
- returns: `Promise<any>`

Trigger the event called `event`, calling all associated listeners **asynchronously** in the order they were registered, passing the supplied arguments to each. If the first argument is an object, it will be used as `this` when executing each listener.

If any listener is fulfilled with a value other than `false`, `null` or `undefined`, the returned promise is fulfilled with that value. If all listeners are fulfilled with `false`, `null` or `undefined`, the returned promise is fulfilled with `undefined`. In either case, subsequent listeners will not be called.

#### ctx.on()

#### ctx.once()

#### ctx.off()

#### ctx.events.start()

#### ctx.events.stop()

#### ctx.events.register()

#### ctx.events.unregister()

### Registry

`ctx.registry` is a built-in service of plugin management. It is actually a subclass of `Map<Plugin, Runtime>`, so you can access plugin runtime via methods like `ctx.registry.get()` and `ctx.registry.delete()`.

#### ctx.plugin(plugin, config?)

- plugin: `object` the plugin to apply
- config: `object` config for the plugin
- returns: `Fork`

Apply a plugin.

#### ctx.using(names, callback)

- names: `string[]` service names
- callback: `Function` plugin function

A syntax sugar of below code:

```ts
ctx.plugin({
  using: names,
  plugin: callback,
})
```

### State

State can be accessed via `ctx.state` or passed in in some events.

#### state.uid

- type: `number`

An auto-incrementing unique identifier for the state.

#### state.runtime

- type: [`Runtime`](#runtime)

The plugin runtime associated with the state. If the state is a runtime, then this property refers to itself.

#### state.parent

#### state.context

#### state.config

#### state.collect()

#### state.restart()

#### state.update()

#### state.dispose()

### Fork

### Runtime

Runtime is a subclass of [`State`](#state), representing the runtime state of a plugin.

It can be accessed via `ctx.runtime` or passed in in some events.

#### runtime.name

#### runtime.plugin

#### runtime.children

- type: [`Fork[]`](#fork)

#### runtime.isForkable

### Events

#### ready()

The `ready` event is triggered when the application starts. If a `ready` listener is registered in a application that has already started, it will be called immediately.

See: [Application lifecycle](#application-lifecycle-)

#### dispose()

The `dispose` event is triggered when the context is unloaded. It can be used to clean up plugins' side effects.

See: [Clean up side effects](#clean-up-side-effects-)

#### fork(ctx, config)

- ctx: `Context`
- config: `any`

The `fork` event is triggered when the plugin is loaded. It is used to create reusable plugins.

See: [Reusable plugins](#reusable-plugins-)

#### internal/warning(...param)

- param: `any[]`

#### internal/hook(name, listener, prepend)

- name: `string`
- listener: `Function`
- prepend: `boolean`
- returns: `() => boolean`

#### internal/service(name)

- name: `string`
- oldValue: `any`

#### internal/runtime(runtime)

- runtime: `Runtime`

#### internal/fork(fork)

- fork: `Fork`

#### internal/update(fork, config)

- fork: `Fork`
- config: `any`

# Cordis

[![Codecov](https://img.shields.io/codecov/c/github/cordiverse/cordis?style=flat-square)](https://codecov.io/gh/cordiverse/cordis)
[![downloads](https://img.shields.io/npm/dm/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![npm](https://img.shields.io/npm/v/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![GitHub](https://img.shields.io/github/license/cordiverse/cordis?style=flat-square)](https://github.com/cordiverse/cordis/blob/master/LICENSE)

Cordis is an AOP framework for modern JavaScript applications. You can think of it as a kind of meta-framework as developers can build their own frameworks on top of it.

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
  - [Clear side effects](#clear-side-effects-)
  - [Reusable plugins](#reusable-plugins-)
- [Service](#service-)
  - [Built-in services](#built-in-services-)
  - [Use services](#use-services-)
  - [Write services](#write-services-)
  - [Write disposable methods](#write-disposable-methods-)
  - [Service isolation](#service-isolation-)
- [Context](#context-)
  - [Services and mixins](#services-and-mixins-)

## Guide [↑](#contents)

Creating a cordis application is very simple:

```ts
import { Context } from 'cordis'

const ctx = new Context()
```

Almost every feature of cordis is based on contexts. We will see how to use them in the following sections.

### Events [↑](#contents)

Cordis has a built-in event model with lifecycle management.

#### Listen to events [↑](#contents)

To add an event listener, simply use `ctx.on()`, which is similar to the `EventEmitter` that comes with Node.js: the first parameter indicates the name of the event and the second parameter is the callback function. We also support similar methods `ctx.once()`, which is used to listen to events only once, and `ctx.off()`, which is used to cancel as event listeners.

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

In cordis, triggering an event can take many forms. Currently, we support four methods with some differences between them:

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
- `fork`: triggered every time when the plugin is loaded

The `ready` event is triggered when the application starts. If a `ready` listener is registered in an application that has already started, it will be called immediately. Below is an example:

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
- should be called after other plugins are ready (for example performance checks)

We will talk about `dispose` and `fork` events in the next section.

### Plugin [↑](#contents)

A **plugin** is in one of three basic forms:

- a function that accepts two parameters, of which the first is the plugin context, and the second is the provided options
- a class that accepts above parameters
- an object with an `apply` method in the form of the above function

When a plugin is loaded, it is basically equivalent to calling the above function or class. Therefore, the following four ways of adding an event listener is basically equivalent:

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

`ctx.plugin()` returns a `ForkScope` instance. To unload a plugin, we can use the `dispose()` method of it:

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

Some plugins can be loaded multiple times. To unload every fork of a plugin without access to the `ForkScope` instance, we can use `ctx.registry`:

```ts
// remove all forks of the plugin
// return true if the plugin is active
ctx.registry.delete(plugin)
```

#### Clear side effects [↑](#contents)

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

Note that the `fork` listener itself is a plugin function. You can also listen to `dispose` event inside `fork` listeners, which serves a different purpose: the inner `dispose` listener is called when the fork is unloaded, while the outer `dispose` listener is called when the whole plugin is unloaded (either via `ctx.registry.delete()` or when unloaded all forks).

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

Finally, cordis provides a syntactic sugar for fully reusable plugins (i.e. plugins which only have fork listeners):

```ts
// mark the callback as fork listener
export const reusable = true

export function apply(ctx) {
  // do something
}
```

```ts
// equivalent to
export function apply(ctx) {
  ctx.on('fork', (ctx) => {
    // do something
  })
}
```

For class plugins, simply use the static property:

```ts
export default class MyPlugin {
  static reusable = true

  constructor(ctx) {
    // do something
  }
}
```

### Service [↑](#contents)

A **service** is an object that can be accessed by multiple contexts. Most of the contexts' functionalities come from services.

For ones who are familiar with IoC / DI, services provide an IoC (inversion of control), but is not implemented through DI (dependency injection). Cordis provides easy access to services within the context through TypeScript's unique mechanism of declaration merging.

#### Built-in services [↑](#contents)

Cordis has three built-in services:

- `ctx.events`: event model and lifecycle
- `ctx.registry`: plugin management
- `ctx.root`: the root context

You can access these services from any contexts.

#### Use services [↑](#contents)

Some plugins may depend on certain services. For example, supposing we have a service called `database`, and we want to use it in a plugin:

```ts
export function apply(ctx) {
  // fetch data from the database
  ctx.database.get(table, id)
}
```

Trying to load this plugin is likely to result in an error because `ctx.database` may be `undefined` when the plugin is loaded. The way to fix this problem depends on when and how the service is used.

If the service is only optional needed when the application is running (e.g. referenced in some event listener), we can simply check the availability of the service before using it:

```ts
export function apply(ctx) {
  ctx.on('custom-event', () => {
    // check if the service is available
    if (!ctx.database) return
    ctx.database.get(table, id)
  })
}
```

However, If a plugin completely depends on the service, we cannot just check the service in the plugin callback, because when the plugin is loaded, the service may not be available yet. To make sure that the plugin is loaded only when the service is available, we can use a special property called `inject`:

```ts
export const inject = ['database']

export function apply(ctx) {
  // fetch data from the database
  ctx.database.get(table, id)
}
```

```ts
// for class plugins, simply use static property
export default class MyPlugin {
  static inject = ['database']

  constructor(ctx) {
    // fetch data from the database
    ctx.database.get(table, id)
  }
}
```

`inject` is a list of service dependencies. If a service is a dependency of a plugin, it means:

- the plugin will not be loaded until the service becomes truthy
- the plugin will be unloaded as soon as the service changes
- if the changed value is still truthy, the plugin will be reloaded

For plugins whose functions depend on a service, we also provide a syntactic sugar `ctx.inject()`:

```ts
ctx.inject(['database'], (ctx) => {
  ctx.database.get(table, id)
})

// equivalent to
ctx.plugin({
  inject: ['database'],
  apply: (ctx) => {
    ctx.database.get(table, id)
  },
})
```

Similar to fork callbacks, always use the `ctx` parameter of the callback instead of the outer `ctx` for disposability.

#### Write services [↑](#contents)

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

#### Write disposable methods [↑](#contents)

It is good practice to write disposable methods for services so that plugins can use them without worrying about the cleanup of resources. Take a simple list service as an example:

```ts
class ListService extends Service {
  constructor(ctx) {
    super(ctx, 'list', true)
    this.data = []
  }

  addItem(item) {
    this.data.push(item)
    // return a dispose function
    return this.ctx.collect('list-item', () => {
      return this.removeItem(item)
    })
  }

  removeItem(item) {
    const index = this.data.indexOf(item)
    if (index >= 0) {
      this.data.splice(index, 1)
      return true
    } else {
      return false
    }
  }
}
```

`ListService` provides two methods: `addItem` and `removeItem`.

- The `addItem` method adds an item to the list and returns a dispose function which can be used to remove the item from the list. When the caller context is disposed, the disposable function will be automatically called.
- The `removeItem` method removes an item from the list and returns a boolean value indicating whether the item is successfully removed.

In the above example, `addItem` is implemented as disposable via `this.ctx.collect()`. `caller` is a special property which always points to the last context which access the service. `ctx.collect()` accepts two parameters: the first is the name of disposable, the second is the callback function.

#### Service isolation [↑](#contents)

> Note: this is an experimental API and may be changed in the future.

By default, a service is available in all contexts. Below is an example:

```ts
ctx.custom                      // undefined
// register the service with a plugin
const fork = ctx.plugin(CustomService)
ctx.custom                      // CustomService
// unload the service plugin
fork.dispose()
ctx.custom                      // undefined
```

Registering multiple services will only override themselves. In order to limit the scope of a service (so that multiple services may exist at the same time), simply create an isolated scope:

```ts
const ctx1 = ctx.isolate('foo')
const ctx2 = ctx.isolate('bar')

ctx.foo = { value: 1 }
ctx1.foo                        // undefined
ctx2.foo                        // { value: 1 }

ctx1.bar = { value: 2 }
ctx.bar                         // { value: 2 }
ctx2.bar                        // undefined
```

`ctx.isolate()` accepts a parameter `key` and returns a new context. Service named `key` will be isolated in the new context, while other services are still shared with the parent context.

> Note: there is an edge case when using service isolation, service dependencies and `fork` events at the same time. Forks from a partially reusable plugin are **not** responsive to isolated service changes, because it may cause unexpected reloading across forks. If you want to write reusable plugin with service dependencies, just use `reusable` property instead of listening to `fork` event.

### Context [↑](#contents)

Context provides API for framework developers rather than users. You can create your own framework based on cordis with context API.

#### Services and mixins [↑](#contents)

`Context.service()` is a static method that registers a service. If you write your service as a derived class, you do not need to call this method because cordis will automatically register the service.

This method is useful for framework developers who may want to provide built-in services or just declare abstract services which may not be implemented by plugins.

```ts
// declare an abstract service
Context.service('database')

function apply(ctx) {
  // use the database service
  ctx.database.get(table, id)
}
```

`Context.mixin()` is a static method that allows you to delegate properties and methods to the context.

> Note: please don't abuse this feature, as adding a lot of mixins can lead to name conflicts.

```ts
Context.mixin('state', {
  // delegate `ctx.scope.collect()` to `ctx.collect()`
  methods: ['collect', 'accept', 'update'],
})
```

Mixins from services will still support service features such as [disposable](#write-disposable-methods-) and [isolation](#service-isolation-).

## API

### Context

#### ctx.extend(meta)

- meta: `Partial<Context.Meta>` additional properties
- returns: `Context`

Create a new context with the current context as the prototype. Properties specified in `meta` will be assigned to the new context.

#### ctx.isolate(key)

> Note: this is an experimental API and may be changed in the future.

- key: `string` service name
- returns: `Context`

Create a new context with the current context as the prototype. Service named `key` will be isolated in the new context, while other services are still shared with the parent context.

See: [Service isolation](#service-isolation-)

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

`ctx.registry` is a built-in service of plugin management. It is actually a subclass of `Map<Plugin, MainScope>`, so you can access plugin runtime via methods like `ctx.registry.get()` and `ctx.registry.delete()`.

#### ctx.plugin(plugin, config?)

- plugin: `object` the plugin to apply
- config: `object` config for the plugin
- returns: `ForkScope`

Apply a plugin.

#### ctx.inject(deps, callback)

- deps: `string[] | Inject` dependencies
- callback: `Function` plugin function

A syntax sugar of below code:

```ts
ctx.plugin({
  inject: deps,
  plugin: callback,
})
```

See: [Use services](#use-services-)

### EffectScope

`EffectScope` can be accessed via `ctx.scope` or passed-in in some events.

#### scope.uid

- type: `number`

An auto-incrementing unique identifier for the effect scope.

#### scope.runtime

- type: [`MainScope`](#mainscope)

The plugin runtime associated with the effect scope. If the scope is a runtime, then this property refers to itself.

#### scope.parent

#### scope.context

#### scope.config

#### scope.collect()

#### scope.restart()

#### scope.update()

#### scope.dispose()

### ForkScope

### MainScope

MainScope is a subclass of [`EffectScope`](#effectscope), representing the main scope of a plugin.

It can be accessed via `ctx.scope.main` or passed-in in some events.

#### runtime.name

#### runtime.plugin

#### runtime.children

- type: [`ForkScope[]`](#forkscope)

#### runtime.isForkable

### Events

#### ready()

The `ready` event is triggered when the application starts. If a `ready` listener is registered in an application that has already started, it will be called immediately.

See: [Application lifecycle](#application-lifecycle-)

#### dispose()

The `dispose` event is triggered when the context is unloaded. It can be used to clean up plugins' side effects.

See: [Clear side effects](#clear-side-effects-)

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

- runtime: `MainScope`

#### internal/fork(fork)

- fork: `ForkScope`

#### internal/update(fork, config)

- fork: `ForkScope`
- config: `any`

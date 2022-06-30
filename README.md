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

## Concepts

### Context

Contexts provide three kinds of functionality:

- allowing access to services (service container)
- managing states of plugins (plugin context)
- filtering sessions for events (session context)

### Plugin

### Service

### Events

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

### Lifecycle

`ctx.lifecycle` is a built-in service which provides event-related functionality. Most of its methods are also directly accessible in the context.

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

#### ctx.lifecycle.start()

#### ctx.lifecycle.stop()

#### ctx.lifecycle.register()

#### ctx.lifecycle.unregister()

### Registry

`ctx.registry` is a built-in service which provides plugin-related functionality. It is actually a subclass of `Map<Plugin, Runtime>`, so you can access plugin runtime via methods like `ctx.registry.get()`.

#### ctx.plugin()

#### ctx.using()

#### ctx.dispose()

### State

State can be accessed via `ctx.state` or passed in in some events.

#### state.uid

- type: `number`

An auto-incrementing unique identifier for the state.

#### state.runtime

- type: `Runtime`

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

#### runtime.name

#### runtime.plugin

#### runtime.isForkable

### Events

#### ready()

The `ready` event is triggered when the lifecycle starts. If a `ready` listener is registered in a lifecycle that has already started, it will be called immediately.

It is recommended to wrap code in the `ready` event in the following scenarios:

- contains asynchronous operations (for example IO-intensive tasks)
- should be called after other plugins are ready (for exmaple performance checks)

#### dispose()

#### fork(ctx, config)

- ctx: `Context`
- config: `any`

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

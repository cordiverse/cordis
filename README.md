# Cordis

[![Codecov](https://img.shields.io/codecov/c/github/shigma/cordis?style=flat-square)](https://codecov.io/gh/shigma/cordis)
[![downloads](https://img.shields.io/npm/dm/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![npm](https://img.shields.io/npm/v/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![GitHub](https://img.shields.io/github/license/shigma/cordis?style=flat-square)](https://github.com/shigma/cordis/blob/master/LICENSE)

AOP Framework for Modern JavaScript Applications.

```ts
import { App } from 'cordis'

const app = new App()

app.plugin(plugin)              // use plugins
app.on(event, callback)         // listen to events

app.start()                     // start app
```

## Concepts

### App

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

- meta: `Partial<Context.Meta>`
- returns: `Context`

Creates a new context. All properties of the new context are inherited from the current context, except for properties specified in meta which are overridden.

### Lifecycle

`ctx.lifecycle` is a built-in service which provides event-related functionality. Most of its methods are also directly accessible in the context.

#### ctx.parallel()

#### ctx.emit()

#### ctx.serial()

#### ctx.bail()

#### ctx.on()

#### ctx.once()

#### ctx.off()

#### ctx.lifecycle.start()

#### ctx.lifecycle.stop()

#### ctx.lifecycle.mark()

#### ctx.lifecycle.register()

#### ctx.lifecycle.unregister()

### Registry

`ctx.registry` is a built-in service which provides plugin-related functionality. It is actually a subclass of `Map<Plugin, Runtime>`, so you can access plugin runtime via methods like `ctx.registry.get()`.

#### ctx.plugin()

#### ctx.using()

#### ctx.dispose()

### State

#### state.uid

- type: `number`

An auto-incrementing unique identifier for the state.

#### state.runtime

- type: `Runtime`

The plugin runtime associated with the state. If the state is a runtime, then this property refers to itself.

#### state.parent

#### state.context

#### state.restart()

#### state.update()

#### state.dispose()

### Events

#### ready

#### dispose

#### fork

#### plugin-added

#### plugin-removed

#### internal/warn

#### internal/hook

#### internal/service

#### internal/update

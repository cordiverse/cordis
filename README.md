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

### Lifecycle

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

#### ctx.plugin()

#### ctx.using()

#### ctx.dispose()

### State

#### state.uid

#### state.runtime

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

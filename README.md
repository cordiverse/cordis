# Cordis

[![Codecov](https://img.shields.io/codecov/c/github/shigma/cordis?style=flat-square)](https://codecov.io/gh/shigma/cordis)
[![downloads](https://img.shields.io/npm/dm/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![npm](https://img.shields.io/npm/v/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![GitHub](https://img.shields.io/github/license/shigma/cordis?style=flat-square)](https://github.com/shigma/cordis/blob/master/LICENSE)

Infrastructure for Modern JavaScript Framework.

```ts
import { Context } from 'cordis'

const ctx = new Context()

ctx.plugin(plugin)              // use plugins
ctx.on(event, callback)         // listen to events

ctx.lifecycle.start()           // start app
```

## Concepts

### Context

Contexts provide three kinds of functionality:

- allowing access to services (service container)
- managing states of plugins (plugin context)
- filtering sessions before events (session context)

### Plugin

### Service

### Events

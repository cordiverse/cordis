# Cordis

[![Codecov](https://img.shields.io/codecov/c/github/shigma/cordis?style=flat-square)](https://codecov.io/gh/shigma/cordis)
[![downloads](https://img.shields.io/npm/dm/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![npm](https://img.shields.io/npm/v/cordis?style=flat-square)](https://www.npmjs.com/package/cordis)
[![GitHub](https://img.shields.io/github/license/shigma/cordis?style=flat-square)](https://github.com/shigma/cordis/blob/master/LICENSE)

Infrastructure for Modern JavaScript Frameworks.

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
- filtering sessions before events (session context)

### Plugin

### Service

### Events

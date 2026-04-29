import pkg from '../package.json' with { type: 'json' }
import scaffold from './index.ts'

scaffold({
  name: 'cordis',
  version: pkg.version,
  template: '@cordisjs/boilerplate',
})

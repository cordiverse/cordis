import { createRequire } from 'node:module'
import scaffold from './index.ts'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

scaffold({
  name: 'cordis',
  version,
  template: '@cordiverse/boilerplate',
})

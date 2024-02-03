import assert from 'assert'
import { start } from './index.js'

assert.ok(process.env.CORDIS_LOADER_OPTIONS)

start(JSON.parse(process.env.CORDIS_LOADER_OPTIONS))

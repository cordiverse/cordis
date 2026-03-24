import assert from 'node:assert'
import { start } from './index.ts'

assert.ok(process.env.CORDIS_LOADER_OPTIONS)

start(JSON.parse(process.env.CORDIS_LOADER_OPTIONS))

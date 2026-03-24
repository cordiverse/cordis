#!/usr/bin/env node

import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

await new Context().plugin(Loader, { name: 'cordis' })

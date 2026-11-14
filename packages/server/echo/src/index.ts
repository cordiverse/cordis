import { Context } from 'cordis'
import type {} from '@cordisjs/server'
import z from 'schemastery'

export interface Config {}

export const Config: z<Config> = z.object({})

export const name = 'server:echo'

export const inject = ['server']

export function apply(ctx: Context) {
  ctx.server.post('', async (req, res) => {
    const type = req.headers.get('content-type')
    if (type) res.headers.set('content-type', type)
    res.body = req.body
  })

  ctx.server.ws('', async (req, accept) => {
    const ws = await accept()
    ws.on('message', (data, binary) => {
      ws.send(data, { binary })
    })
  })
}

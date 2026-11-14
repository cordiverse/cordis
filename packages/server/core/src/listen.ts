import type net from 'node:net'

export interface ListenOptions {
  host: string
  port: number
  maxPort?: number
}

export function listen(server: net.Server, { host, port, maxPort = port }: ListenOptions) {
  return new Promise<number>((resolve, reject) => {
    function onListen() {
      server.off('error', onError)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    }

    function onError(err: NodeJS.ErrnoException) {
      server.off('listening', onListen)
      if (!(err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        return reject(err)
      }
      port++
      if (port > maxPort) {
        return reject(new Error('No open ports available'))
      }
      tryListen()
    }

    function tryListen() {
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(port, host)
    }

    tryListen()
  })
}

import { hostname } from 'node:os'
import type { RequestHandler } from 'express'

// No Kubernetes, o hostname padrão do container é o nome do pod.
export const identificarInstancia: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Pod', process.env.POD_NAME ?? hostname())
  res.setHeader('X-Versao', process.env.APP_VERSION ?? 'nao-informada')
  next()
}

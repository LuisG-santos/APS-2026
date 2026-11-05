import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const arquivo = new URL('../../k8s/02-fila-secret.local.yaml', import.meta.url)
const senha = randomBytes(32).toString('hex')
const conteudo = `apiVersion: v1
kind: Secret
metadata:
  name: aps-fila
  namespace: aps
type: Opaque
stringData:
  RABBITMQ_DEFAULT_USER: aps
  RABBITMQ_DEFAULT_PASS: ${senha}
  RABBITMQ_URL: amqp://aps:${senha}@fila:5672?heartbeat=5
`
try {
  await writeFile(arquivo, conteudo, { flag: 'wx', mode: 0o600 })
  console.log('Secret local criado em k8s/02-fila-secret.local.yaml. Nao envie este arquivo ao Git.')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('Secret local da fila ja existe; credenciais preservadas.')
}

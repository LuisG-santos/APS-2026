const [target = 'http://localhost:8080/alagamento/health/live', seconds = '180', workers = '32'] = process.argv.slice(2)
const duration = Number(seconds)
const concurrency = Number(workers)
const url = new URL(target)
if (!['http:', 'https:'].includes(url.protocol) || !Number.isInteger(duration) || duration < 1 || duration > 3600 ||
  !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
  throw new Error('Uso: node scripts/k8s/carga.mjs <URL http(s)> <segundos: 1..3600> <concorrencia: 1..256>')
}

const started = Date.now()
let deadline = started + duration * 1000
let success = 0
let errors = 0
if (process.send) process.on('message', message => {
  if (message === 'stop') deadline = Date.now()
})

async function worker() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      await response.arrayBuffer()
      if (response.ok) success++
      else errors++
    } catch {
      errors++
    }
  }
}

console.log(`GET ${url} por ${duration}s com ${concurrency} requisicoes simultaneas.`)
const progress = setInterval(() => console.log(`Respostas 2xx: ${success}; falhas: ${errors}`), 10000)
try {
  await Promise.all(Array.from({ length: concurrency }, worker))
} finally {
  clearInterval(progress)
}
const elapsed = (Date.now() - started) / 1000
console.log(JSON.stringify({ sucesso: success, falhas: errors, segundos: Number(elapsed.toFixed(2)),
  requisicoesPorSegundo: Number(((success + errors) / elapsed).toFixed(2)) }))
if (errors > 0) process.exitCode = 1
if (process.connected) process.disconnect()

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const reportFile = path.join(project, 'evidencias', 'kubernetes.local.json')
await mkdir(path.dirname(reportFile), { recursive: true })
const results = []
const context = 'docker-desktop'
const prefix = `validacao-${Date.now()}`
const base = 'http://127.0.0.1:18080'
const configs = [
  { name: 'api-alagamento', route: 'alagamento', port: 3001, extra: {}, fields: [['NIVEL','nivelCorregoCm',120.5],['CHUVA','chuvaAcumuladaMm',35.2]] },
  { name: 'api-qualidade-ar', route: 'qualidade-ar', port: 3002, extra: {estacao:'validacao'}, fields: [['MP25','mp25',35.2],['CO','co',0.8],['NO3','no3',12.4],['TEMPERATURA','temperatura',27.5]] },
  { name: 'api-transito', route: 'transito', port: 3003, extra: {}, fields: [['RADAR','velocidade',42.5],['GPS','posicao','-23.55,-46.63'],['OCUPACAO','ocupacao',0.75]] }
]
let forward
let bankStopped = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function run(exe, args, options={}) {
  const child = spawn(exe, args, {cwd:project, env:process.env, windowsHide:true, stdio:['ignore','pipe','pipe'], ...options})
  let out = '', err = ''
  child.stdout.on('data', chunk => {out += chunk})
  child.stderr.on('data', chunk => {err += chunk})
  const timer = setTimeout(() => child.kill(), 90000)
  const [code] = await once(child,'exit')
  clearTimeout(timer)
  assert.equal(code,0,`${exe} ${args.slice(0,6).join(' ')}: ${err || out}`)
  return out
}
const kube = (...args) => run('kubectl',['--context',context,'--request-timeout=15s',...args])
const get = async (kind, name, namespace='aps') => JSON.parse(await kube('get',kind,...(name?[name]:[]),'-n',namespace,'-o','json'))
async function waitFor(label, check, seconds=180) {
  const until = Date.now()+seconds*1000
  let last
  while(Date.now()<until) {
    try { const value=await check(); if(value) return value } catch(error) {last=error}
    await sleep(2000)
  }
  throw new Error(`Timeout: ${label}; ${last?.message || 'condicao nao atingida'}`)
}
async function step(name, operation) {
  console.log(`INICIO ${name}`)
  const start = Date.now()
  try {
    const evidence=await operation()
    results.push({name,status:'aprovado',seconds:Math.round((Date.now()-start)/1000),evidence})
    console.log(`APROVADO ${name}`)
    await writeFile(reportFile,JSON.stringify({context,results},null,2))
    return evidence
  } catch(error) {
    results.push({name,status:'falhou',message:error.message})
    await writeFile(reportFile,JSON.stringify({context,results},null,2))
    throw error
  }
}
async function http(route, suffix, body, expected=body?201:200) {
  const response=await fetch(`${base}/${route}${suffix}`,{method:body?'POST':'GET',
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)})
  const text=await response.text()
  assert.equal(response.status,expected,`${route}${suffix}: ${response.status} ${text}`)
  return JSON.parse(text)
}
async function ready(name) {
  return waitFor(name,async()=>{const d=await get('deployment',name);return d.status.observedGeneration>=d.metadata.generation && d.status.replicas===d.spec.replicas && d.status.availableReplicas===d.spec.replicas && d.status.updatedReplicas===d.spec.replicas},300)
}
async function allPods() {
  const pods=await get('pods','')
  return pods.items.filter(p=>configs.some(c=>p.metadata.labels.app===c.name) && !p.metadata.deletionTimestamp)
}
try {
  await step('Inicializacao e recursos',async()=>{
    for(const c of configs) await ready(c.name)
    await ready('aps-gateway')
    const bank=await get('pod','banco-0'); assert.ok(bank.status.containerStatuses.every(c=>c.ready))
    const pvc=await get('pvc','dados-banco-0'); assert.equal(pvc.status.phase,'Bound')
    const job=await waitFor('Job de migrations',async()=>{const j=await get('job','aps-migrate-etapa3-v1');return j.status.succeeded===1 && j},180)
    const ingress=await get('ingress','aps');assert.equal(ingress.spec.rules[0].http.paths.length,3)
    const api=JSON.parse(await kube('get','apiservice','v1beta1.metrics.k8s.io','-o','json'))
    assert.ok(api.status.conditions.some(c=>c.type==='Available' && c.status==='True'))
    return {pvc:pvc.metadata.uid,job:'Completed',ingress:ingress.spec.ingressClassName}
  })
  forward=spawn('kubectl',['--context',context,'port-forward','-n','aps','service/aps-gateway','18080:80'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
  let forwardLog=''; forward.stdout.on('data',d=>forwardLog+=d);forward.stderr.on('data',d=>forwardLog+=d)
  await waitFor('port-forward',async()=>{if(forward.exitCode!==null) throw new Error(forwardLog); return (await fetch(`${base}/alagamento/health/live`,{signal:AbortSignal.timeout(1000)})).ok},60)
  await step('Ingress e nove tipos de sensor',async()=>{
    let readings=0
    for(const c of configs) {
      assert.equal((await http(c.route,'/health/live')).status,'ok')
      assert.equal((await http(c.route,'/health/ready')).status,'ready')
      c.readings=[]
      for(const [tipo,field,value] of c.fields) {
        const cadastro={nome:`${prefix}-${tipo}`,tipo}
        const sensor=await http(c.route,'/send/sensor',cadastro)
        await http(c.route,'/send/sensor',cadastro,409)
        const timestamp='2026-01-15T09:30:00.123Z'
        const payload={...c.extra,sensorId:sensor.id,timestamp,[field]:value}
        const reading=await http(c.route,`/send/${c.route}`,payload)
        assert.equal(reading.sensor.id,sensor.id);assert.equal(reading.sensor.tipo,tipo)
        assert.equal(reading.timestamp,timestamp);assert.notEqual(reading.createdAt,timestamp)
        for(const [,key] of c.fields) assert.equal(reading[key],field===key?value:null)
        await http(c.route,`/send/${c.route}`,{...payload,[field]:null},400)
        await http(c.route,`/send/${c.route}`,{...payload,sensorId:2147483647},404)
        const other=c.fields.find(([,key])=>key!==field)
        await http(c.route,`/send/${c.route}`,{...payload,[other[1]]:other[2]},400)
        c.readings.push(reading);readings++
      }
      const stored=await http(c.route,`/get/${c.route}`)
      const sensors=await http(c.route,'/get/sensores')
      for(const reading of c.readings) {
        assert.deepEqual(stored.find(r=>r.id===reading.id),reading)
        assert.ok(sensors.some(s=>s.id===reading.sensorId))
      }
    }
    return {readings,types:9,checks:['POST','GET','duplicado 409','sensor inexistente 404','medidas invalidas 400','timestamp preservado']}
  })
  await step('Persistencia apos excluir banco-0',async()=>{
    const before=await get('pod','banco-0');const pvc=await get('pvc','dados-banco-0')
    await kube('delete','pod','banco-0','-n','aps','--wait=true','--timeout=60s')
    const after=await waitFor('novo banco pronto',async()=>{const p=await get('pod','banco-0');return p.metadata.uid!==before.metadata.uid && p.status.containerStatuses?.every(c=>c.ready) && p},180)
    assert.equal((await get('pvc','dados-banco-0')).metadata.uid,pvc.metadata.uid)
    for(const c of configs) {
      await waitFor(c.name,async()=>{try{return (await http(c.route,'/health/ready')).status==='ready'}catch{return false}})
      const stored=await http(c.route,`/get/${c.route}`)
      for(const reading of c.readings) assert.deepEqual(stored.find(r=>r.id===reading.id),reading)
    }
    return {oldPod:before.metadata.uid,newPod:after.metadata.uid,pvc:pvc.metadata.uid,readingsPreserved:9}
  })
  await step('Readiness sem reinicios durante falha do banco',async()=>{
    const before=await allPods()
    try {
      bankStopped=true
      await kube('scale','statefulset/banco','-n','aps','--replicas=0')
      await waitFor('APIs nao prontas',async()=>{const pods=await allPods();return pods.length>=3 && pods.every(p=>p.status.containerStatuses?.every(c=>!c.ready))},120)
      const after=await allPods()
      for(const p of before) {
        const current=after.find(v=>v.metadata.uid===p.metadata.uid);assert.ok(current)
        assert.equal(current.status.containerStatuses[0].restartCount,p.status.containerStatuses[0].restartCount)
      }
      const responses=[]
      for(const c of configs) {
        const pod=after.find(p=>p.metadata.labels.app===c.name)
        const script=`Promise.all(['/health/live','/health/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:${c.port}'+p);return {path:p,status:r.status}})).then(r=>console.log(JSON.stringify(r)))`
        const result=JSON.parse(await kube('exec','-n','aps',pod.metadata.name,'-c','api','--','node','-e',script))
        assert.deepEqual(result.map(r=>r.status),[200,503]);responses.push({api:c.name,result})
      }
      return {restarts:'inalterados',responses}
    } finally {
      await kube('scale','statefulset/banco','-n','aps','--replicas=1'); bankStopped=false
      await waitFor('banco restaurado',async()=>{const p=await get('pod','banco-0');return p.status.containerStatuses?.every(c=>c.ready)})
      for(const c of configs) await ready(c.name)
    }
  })
  await step('RollingUpdate com disponibilidade',async()=>{
    let stop=false,errors=0,success=0
    const checking=(async()=>{while(!stop){try{await http('alagamento','/health/ready');success++}catch{errors++}await sleep(100)}})()
    try {await kube('rollout','restart','deployment/api-alagamento','-n','aps');await ready('api-alagamento')}
    finally {stop=true;await checking}
    assert.ok(success>0);assert.equal(errors,0)
    return {successfulRequests:success,failedRequests:errors}
  })
  await step('Metricas e escala por CPU',async()=>{
    const metrics=JSON.parse(await kube('get','--raw','/apis/metrics.k8s.io/v1beta1/namespaces/aps/pods'))
    assert.ok(metrics.items.length>=4)
    const targets=[]
    for(const c of configs) {
      const hpa=await waitFor(`metricas ${c.name}`,async()=>{const h=await get('hpa',c.name);return h.status.currentMetrics?.some(m=>m.resource?.current?.averageUtilization!==undefined) && h},120)
      targets.push({name:c.name,cpu:hpa.status.currentMetrics})
    }
    const scaling=[]
    for(const c of configs) {
      const load=spawn(process.execPath,[path.join(project,'scripts/k8s/carga.mjs'),`${base}/${c.route}/get/sensores`,'180','64'],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
      let log='';load.stdout.on('data',d=>{log+=d;console.log(d.toString().trim())});load.stderr.on('data',d=>log+=d)
      const observed=[]
      let scaled=false
      try {
        while(load.exitCode===null) {
          const hpa=await get('hpa',c.name);const d=await get('deployment',c.name)
          observed.push({time:new Date().toISOString(),current:hpa.status.currentReplicas,desired:hpa.status.desiredReplicas,cpu:hpa.status.currentMetrics,ready:d.status.availableReplicas})
          if(hpa.status.desiredReplicas>=2 && d.status.availableReplicas>=2) scaled=true
          if(scaled) {
            await sleep(10000)
            break
          }
          await sleep(5000)
        }
      } finally {
        if(load.exitCode===null) {const done=once(load,'exit');load.send('stop');await done}
      }
      assert.equal(load.exitCode,0,log)
      assert.ok(scaled,`Carga nao produziu aumento observado de replicas: ${c.name}; ${log}`)
      const loadSummary=JSON.parse(log.trim().split(/\r?\n/).at(-1))
      assert.ok(loadSummary.sucesso>0)
      assert.equal(loadSummary.falhas,0)
      const access=await kube('logs','-n','aps','deployment/aps-gateway','--tail=200')
      const addresses=[...new Set(access.split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>{try{return JSON.parse(l)}catch{return {}}}).filter(l=>l.ServiceName?.includes(c.name)).map(l=>l.ServiceAddr).filter(Boolean))]
      assert.ok(addresses.length>=2,`Balanceamento nao evidenciado: ${c.name} ${addresses}`)
      scaling.push({api:c.name,observed,backendAddresses:addresses,load:loadSummary})
      console.log(`HPA E BALANCEAMENTO APROVADOS ${c.name}`)
    }
    return {targets,scaling}
  })
  console.log('TODOS OS TESTES KUBERNETES APROVADOS')
} finally {
  if(bankStopped) await kube('scale','statefulset/banco','-n','aps','--replicas=1').catch(()=>{})
  if(forward && forward.exitCode===null) {const done=once(forward,'exit');forward.kill();await done}
  await writeFile(reportFile,JSON.stringify({context,results},null,2))
}

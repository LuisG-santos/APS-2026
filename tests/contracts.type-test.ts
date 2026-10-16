import type { AlagamentoBody, AlagamentoResponse } from '../api-alagamento-inundacao/contracts.js'
import type { QualidadeArBody } from '../api-qualidade-do-ar/contracts.js'
import { isSensorBody, type MedidaTransito, type SensorBody, type SensorResponse, type TransitoBody } from '../api-transito-e-transporte/contracts.js'
import type { ApiRequest, ApiResponse } from '../shared/http.js'

declare function alagamento(body: AlagamentoBody): void
declare function qualidadeAr(body: QualidadeArBody): void
declare function sensor(body: SensorBody): void
declare function transito(body: TransitoBody): void
declare function medida(body: MedidaTransito): void
declare function leitura(body: AlagamentoResponse): void

const timestamp = '2026-10-16T12:00:00.123Z'

alagamento({ sensor: 'nivel-01', timestamp, nivelCorregoCm: 120.5, chuvaAcumuladaMm: 35.2 })
qualidadeAr({ sensor: 'ar-01', estacao: 'centro', timestamp, mp25: 35.2, co: 0.8, no3: 12.4, temperatura: 27.5 })
sensor({ nome: 'radar', tipo: 'RADAR' })
transito({ sensorId: 1, timestamp, velocidade: 42.5 })
transito({ sensorId: 2, timestamp, posicao: '-23.5505,-46.6333' })
transito({ sensorId: 3, timestamp, ocupacao: 0.75 })
leitura({ id: 1, sensor: 'nivel-01', timestamp, nivelCorregoCm: 120.5, chuvaAcumuladaMm: 35.2, createdAt: timestamp })

// @ts-expect-error Medidas numericas nao aceitam strings.
alagamento({ sensor: 'nivel-01', timestamp, nivelCorregoCm: '120.5', chuvaAcumuladaMm: 35.2 })
// @ts-expect-error Qualidade do ar exige a identificacao do equipamento.
qualidadeAr({ estacao: 'centro', timestamp, mp25: 35.2, co: 0.8, no3: 12.4, temperatura: 27.5 })
// @ts-expect-error Apenas os tipos de sensor definidos no contrato sao aceitos.
sensor({ nome: 'radar', tipo: 'CAMERA' })
// @ts-expect-error O nome de um equipamento deve ser uma string.
sensor({ nome: 1, tipo: 'RADAR' })
// @ts-expect-error sensorId e um numero, nao uma string.
transito({ sensorId: '1', timestamp, velocidade: 42.5 })
// @ts-expect-error Uma leitura nao pode conter duas medidas.
transito({ sensorId: 1, timestamp, velocidade: 42.5, posicao: '-23,-46' })
// @ts-expect-error Uma leitura deve conter uma medida.
transito({ sensorId: 1, timestamp })
// @ts-expect-error A medida preserva a exclusividade mesmo fora do corpo HTTP.
medida({ velocidade: 42.5, ocupacao: 0.75 })
// @ts-expect-error Timestamp recebido no JSON deve ser uma string.
transito({ sensorId: 1, timestamp: new Date(), velocidade: 42.5 })

declare const request: ApiRequest<SensorResponse>
// @ts-expect-error O corpo recebido e desconhecido ate passar pela validacao.
sensor(request.body)
// @ts-expect-error Campos do corpo nao podem ser acessados antes da validacao.
request.body.nome
if (isSensorBody(request.body)) sensor(request.body)

declare const response: ApiResponse<SensorResponse>
response.json({ id: 1, nome: 'radar', tipo: 'RADAR', createdAt: timestamp })
response.json({ error: 'sensor invalido' })
// @ts-expect-error A resposta de sensor exige ID e data de criacao.
response.json({ nome: 'radar', tipo: 'RADAR' })
// @ts-expect-error Datas na resposta JSON sao strings ISO, nao objetos Date.
response.json({ id: 1, nome: 'radar', tipo: 'RADAR', createdAt: new Date() })

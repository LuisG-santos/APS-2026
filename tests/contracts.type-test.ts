import {
  isSensorAlagamentoBody, type AlagamentoBody, type AlagamentoResponse, type SensorAlagamentoBody
} from '../api-alagamento-inundacao/contracts.js'
import {
  isSensorQualidadeArBody, type QualidadeArBody, type SensorQualidadeArBody
} from '../api-qualidade-do-ar/contracts.js'
import { isSensorBody, type MedidaTransito, type SensorBody, type SensorResponse, type TransitoBody } from '../api-transito-e-transporte/contracts.js'
import type { ApiRequest, ApiResponse } from '../shared/http.js'

declare function alagamento(body: AlagamentoBody): void
declare function qualidadeAr(body: QualidadeArBody): void
declare function sensorAlagamento(body: SensorAlagamentoBody): void
declare function sensorQualidadeAr(body: SensorQualidadeArBody): void
declare function sensor(body: SensorBody): void
declare function transito(body: TransitoBody): void
declare function medida(body: MedidaTransito): void
declare function leitura(body: AlagamentoResponse): void

const timestamp = '2026-10-16T12:00:00.123Z'

sensorAlagamento({ nome: 'nivel-01', tipo: 'NIVEL_CORREGO' })
sensorAlagamento({ nome: 'pluviometro', tipo: 'PLUVIOMETRO' })
alagamento({ sensorId: 1, timestamp, nivelCorregoCm: 120.5 })
alagamento({ sensorId: 2, timestamp, chuvaAcumuladaMm: 35.2 })
sensorQualidadeAr({ nome: 'particulas', tipo: 'MP25', estacao: 'centro' })
sensorQualidadeAr({ nome: 'monoxido', tipo: 'CO', estacao: 'centro' })
sensorQualidadeAr({ nome: 'dioxido-nitrogenio', tipo: 'NO2', estacao: 'centro' })
sensorQualidadeAr({ nome: 'termometro', tipo: 'TEMPERATURA', estacao: 'centro' })
qualidadeAr({ sensorId: 1, timestamp, mp25: 35.2 })
qualidadeAr({ sensorId: 2, timestamp, co: 0.8 })
qualidadeAr({ sensorId: 3, timestamp, no2: 12.4 })
qualidadeAr({ sensorId: 4, timestamp, temperatura: 27.5 })
sensor({ nome: 'radar', tipo: 'RADAR' })
transito({ sensorId: 1, timestamp, velocidade: 42.5 })
transito({ sensorId: 2, timestamp, posicao: '-23.5505,-46.6333' })
transito({ sensorId: 3, timestamp, ocupacao: 0.75 })
leitura({
  id: 1, sensorId: 1, sensor: { id: 1, nome: 'nivel-01', tipo: 'NIVEL_CORREGO', createdAt: timestamp },
  timestamp, nivelCorregoCm: 120.5, chuvaAcumuladaMm: null, nivelAguaViaCm: null, createdAt: timestamp
})

// @ts-expect-error O tipo de sensor deve pertencer a API de alagamento.
sensorAlagamento({ nome: 'radar', tipo: 'RADAR' })
// @ts-expect-error Medidas numericas nao aceitam strings.
alagamento({ sensorId: 1, timestamp, nivelCorregoCm: '120.5' })
// @ts-expect-error Alagamento exige o ID do equipamento cadastrado.
alagamento({ sensor: 'nivel-01', timestamp, nivelCorregoCm: 120.5 })
// @ts-expect-error Alagamento aceita apenas uma medida por leitura.
alagamento({ sensorId: 1, timestamp, nivelCorregoCm: 120.5, chuvaAcumuladaMm: 35.2 })
// @ts-expect-error Uma leitura de alagamento exige uma medida.
alagamento({ sensorId: 1, timestamp })
// @ts-expect-error O tipo de sensor deve pertencer a API de qualidade do ar.
sensorQualidadeAr({ nome: 'nivel', tipo: 'NIVEL_CORREGO', estacao: 'centro' })
// @ts-expect-error Qualidade do ar exige o ID do equipamento cadastrado.
qualidadeAr({ sensor: 'ar-01', timestamp, mp25: 35.2 })
// @ts-expect-error Estacao e obrigatoria no cadastro do sensor.
sensorQualidadeAr({ nome: 'particulas', tipo: 'MP25' })
// @ts-expect-error Qualidade do ar aceita apenas uma medida por leitura.
qualidadeAr({ sensorId: 1, timestamp, mp25: 35.2, temperatura: 27.5 })
// @ts-expect-error A medida de qualidade do ar deve ser numerica.
qualidadeAr({ sensorId: 1, timestamp, co: '0.8' })
// @ts-expect-error Uma leitura de qualidade do ar exige uma medida.
qualidadeAr({ sensorId: 1, timestamp })
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
if (isSensorAlagamentoBody(request.body)) sensorAlagamento(request.body)
if (isSensorQualidadeArBody(request.body)) sensorQualidadeAr(request.body)

declare const response: ApiResponse<SensorResponse>
response.json({ id: 1, nome: 'radar', tipo: 'RADAR', createdAt: timestamp })
response.json({ error: 'sensor invalido' })
// @ts-expect-error A resposta de sensor exige ID e data de criacao.
response.json({ nome: 'radar', tipo: 'RADAR' })
// @ts-expect-error Datas na resposta JSON sao strings ISO, nao objetos Date.
response.json({ id: 1, nome: 'radar', tipo: 'RADAR', createdAt: new Date() })

sensorAlagamento({ nome: 'nivel-via-01', tipo: 'NIVEL_VIA' })
alagamento({ sensorId: 3, timestamp, nivelAguaViaCm: 8.0 })
// @ts-expect-error Nivel na via tambem exige uma unica medida por leitura.
alagamento({ sensorId: 3, timestamp, nivelAguaViaCm: 8.0, chuvaAcumuladaMm: 5 })
// @ts-expect-error O tipo antigo NIVEL foi substituido por NIVEL_CORREGO.
sensorAlagamento({ nome: 'nivel-01', tipo: 'NIVEL' })

// @ts-expect-error O campo antigo no3 foi substituido por no2.
qualidadeAr({ sensorId: 1, timestamp, no3: 12.4 })
// @ts-expect-error Estacao pertence ao cadastro, nao a leitura.
qualidadeAr({ sensorId: 1, timestamp, mp25: 35.2, estacao: 'centro' })
// @ts-expect-error NO3 nao e mais um tipo valido.
sensorQualidadeAr({ nome: 'antigo', tipo: 'NO3', estacao: 'centro' })

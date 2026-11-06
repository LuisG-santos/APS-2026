export type CodigoErroTransito = 'NOME_DUPLICADO' | 'TIMESTAMP_INVALIDO' | 'SENSOR_NAO_ENCONTRADO' | 'MEDIDA_INCOMPATIVEL'

export class ErroTransito extends Error {
  constructor(public readonly codigo: CodigoErroTransito, mensagem: string) {
    super(mensagem)
    this.name = 'ErroTransito'
  }
}

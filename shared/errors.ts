export type CodigoErro = 'TIMESTAMP_INVALIDO' | 'SENSOR_NAO_ENCONTRADO' | 'MEDIDA_INCOMPATIVEL' | 'NOME_DUPLICADO'

export class ErroAplicacao extends Error {
  constructor(public readonly codigo: CodigoErro, mensagem: string) {
    super(mensagem)
    this.name = 'ErroAplicacao'
  }
}

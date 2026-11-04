export type CodigoErroAlagamento = 'NOME_DUPLICADO' | 'TIMESTAMP_INVALIDO' | 'SENSOR_NAO_ENCONTRADO' | 'MEDIDA_INCOMPATIVEL'

export class ErroAlagamento extends Error {
  constructor(public readonly codigo: CodigoErroAlagamento, mensagem: string) {
    super(mensagem)
    this.name = 'ErroAlagamento'
  }
}

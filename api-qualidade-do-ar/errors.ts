export type CodigoErroQualidadeAr = 'NOME_DUPLICADO' | 'TIMESTAMP_INVALIDO' | 'SENSOR_NAO_ENCONTRADO' | 'MEDIDA_INCOMPATIVEL'

export class ErroQualidadeAr extends Error {
  constructor(public readonly codigo: CodigoErroQualidadeAr, mensagem: string) {
    super(mensagem)
    this.name = 'ErroQualidadeAr'
  }
}

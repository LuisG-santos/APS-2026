import type { Request, Response } from 'express'

export interface ErrorResponse {
  error: string
}

export interface LiveResponse {
  status: 'ok'
}

export interface ReadyResponse {
  status: 'ready' | 'unavailable'
}

export type ApiRequest<TResponse> = Request<Record<string, never>, TResponse | ErrorResponse, unknown>
export type ApiResponse<TResponse> = Response<TResponse | ErrorResponse>

export type CreatedJson<T extends { createdAt: Date }> = Omit<T, 'createdAt'> & {
  createdAt: string
}

export type ReadingJson<T extends { timestamp: Date; createdAt: Date }> = Omit<T, 'timestamp' | 'createdAt'> & {
  timestamp: string
  createdAt: string
}

export function serializeCreated<T extends { createdAt: Date }>(value: T): CreatedJson<T> {
  const { createdAt, ...fields } = value
  return { ...fields, createdAt: createdAt.toISOString() }
}

export function serializeReading<T extends { timestamp: Date; createdAt: Date }>(value: T): ReadingJson<T> {
  const { timestamp, createdAt, ...fields } = value
  return { ...fields, timestamp: timestamp.toISOString(), createdAt: createdAt.toISOString() }
}

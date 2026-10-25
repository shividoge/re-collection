// A reactive Convex query that reports errors as state instead of throwing into React.
import { useQuery_experimental } from 'convex/react'
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'
import { errorMessage } from './errors'

export type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string }

export function useLive<Q extends FunctionReference<'query'>>(query: Q, args: FunctionArgs<Q> | 'skip'): Loadable<FunctionReturnType<Q>> {
  const result = useQuery_experimental({ query, args })
  if (result.status === 'success') return { status: 'ready', data: result.data }
  if (result.status === 'error') return { status: 'error', message: errorMessage(result.error) }
  return { status: 'loading' }
}

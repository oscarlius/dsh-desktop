import { API_PATHS } from '../http-contract.js'
import type { CompanyStatus } from '../public-status.js'
import type { P7AccountStatus, P7Usage } from '../account-broker.js'

export interface CompanyModelsApi {
  status(signal?: AbortSignal): Promise<CompanyStatus>
  connect(input: { origin: string; apiKey: string }, signal?: AbortSignal): Promise<CompanyStatus>
  sync(signal?: AbortSignal): Promise<CompanyStatus>
  disconnect(signal?: AbortSignal): Promise<CompanyStatus>
  accountStatus(signal?: AbortSignal): Promise<P7AccountStatus>
  accountLogin(signal?: AbortSignal): Promise<P7AccountStatus>
  accountLogout(signal?: AbortSignal): Promise<P7AccountStatus>
  accountUsage(input: { from: string; to: string; groupBy?: 'day' | 'model' | 'service' }, signal?: AbortSignal): Promise<P7Usage>
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

async function readStatus(response: Response): Promise<CompanyStatus> {
  if (!response.ok) throw new Error(`P7 company models request failed (${response.status})`)
  return await response.json() as CompanyStatus
}

function post(fetcher: Fetcher, path: string, body: object, signal?: AbortSignal): Promise<CompanyStatus> {
  return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }).then(readStatus)
}
async function json<T>(fetcher: Fetcher, path: string, init: RequestInit): Promise<T> { const response = await fetcher(path, init); if (!response.ok) throw new Error(`P7 account request failed (${response.status})`); return await response.json() as T }

export function createCompanyModelsApi(fetcher: Fetcher = fetch): CompanyModelsApi {
  return {
    status: async signal => await readStatus(await fetcher(API_PATHS.status, {
      method: 'GET', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json' },
    })),
    connect: async (input, signal) => await post(fetcher, API_PATHS.connect, input, signal),
    sync: async signal => await post(fetcher, API_PATHS.sync, {}, signal),
    disconnect: async signal => await post(fetcher, API_PATHS.disconnect, {}, signal),
    accountStatus: async signal => await json<P7AccountStatus>(fetcher, API_PATHS.accountStatus, { method: 'GET', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json' } }),
    accountLogin: async signal => await json<P7AccountStatus>(fetcher, API_PATHS.accountLogin, { method: 'POST', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' }),
    accountLogout: async signal => await json<P7AccountStatus>(fetcher, API_PATHS.accountLogout, { method: 'POST', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' }),
    accountUsage: async (input, signal) => await json<P7Usage>(fetcher, `${API_PATHS.accountUsage}?${new URLSearchParams({ from: input.from, to: input.to, groupBy: input.groupBy ?? 'day' })}`, { method: 'GET', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json' } }),
  }
}

import { API_PATHS } from '../http-contract.js'
import type { CompanyStatus } from '../public-status.js'

export interface CompanyModelsApi {
  status(signal?: AbortSignal): Promise<CompanyStatus>
  connect(input: { origin: string; apiKey: string }, signal?: AbortSignal): Promise<CompanyStatus>
  sync(signal?: AbortSignal): Promise<CompanyStatus>
  disconnect(signal?: AbortSignal): Promise<CompanyStatus>
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

export function createCompanyModelsApi(fetcher: Fetcher = fetch): CompanyModelsApi {
  return {
    status: async signal => await readStatus(await fetcher(API_PATHS.status, {
      method: 'GET', credentials: 'same-origin', redirect: 'error', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'application/json' },
    })),
    connect: async (input, signal) => await post(fetcher, API_PATHS.connect, input, signal),
    sync: async signal => await post(fetcher, API_PATHS.sync, {}, signal),
    disconnect: async signal => await post(fetcher, API_PATHS.disconnect, {}, signal),
  }
}

/** Same-origin Host endpoints, independent of the remote P7 gateway. */
export const API_PATHS = {
  status: '/p7-company-models/status', connect: '/p7-company-models/connect',
  sync: '/p7-company-models/sync', disconnect: '/p7-company-models/disconnect',
} as const


// Runtime config — values injected by Vite from .env / CI environment variables
// All VITE_* vars are public (bundled into JS). Never put secrets here.

export const SUPABASE_URL     = import.meta.env.VITE_SUPABASE_URL     ?? ''
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''
export const HF_ENDPOINT       = import.meta.env.VITE_HF_ENDPOINT       ?? ''

// Derived URLs
export const ACR_EDGE_FN = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/acr-scan`
  : ''

// Feature flags — true only when the relevant service is configured
export const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
export const HF_READY       = Boolean(HF_ENDPOINT)

export function slugifyName(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'capa'
  )
}

// Sites que JÁ entregam PT-BR — tradução é desnecessária (e custaria $$ à toa).
export const PT_NATIVE_HOSTS = ['novelmania.com.br']

export function matchHost(rawUrl: string, hosts: string[]): boolean {
  try {
    const host = new URL(rawUrl.trim()).hostname.replace(/^www\./, '')
    return hosts.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

// Matcha duas URLs ignorando fragment/trailing slash e domínio de mirror.
export function urlsMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  const norm = (u: string): string => {
    try {
      const parsed = new URL(u)
      const path = parsed.pathname.replace(/\/$/, '')
      return path.toLowerCase()
    } catch {
      return u.toLowerCase()
    }
  }
  return norm(a) === norm(b)
}

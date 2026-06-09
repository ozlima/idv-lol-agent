import https from "https"

const RIOT_API_KEY = process.env.RIOT_API_KEY ?? ""
const RIOT_REGION  = (process.env.RIOT_REGION  ?? "br1").toLowerCase()

// ─── Rate limiter (sliding window) ───────────────────────────────────────────
// Dev key limits: 20 req/1s, 100 req/2min.
// We run slightly below to have headroom.

class RateLimiter {
  private windows = [
    { duration: 1_000,   limit: 18, ts: [] as number[] },
    { duration: 120_000, limit: 95, ts: [] as number[] },
  ]
  private blockedUntil = 0

  async wait(): Promise<void> {
    const blocked = this.blockedUntil - Date.now()
    if (blocked > 0) {
      console.log(`[riot-api] Aguardando Retry-After (${Math.ceil(blocked / 1000)}s)`)
      await sleep(blocked)
    }

    while (true) {
      const now = Date.now()
      let needMs = 0

      for (const w of this.windows) {
        w.ts = w.ts.filter(t => now - t < w.duration)
        if (w.ts.length >= w.limit) {
          const wait = w.duration - (now - w.ts[0]) + 10
          needMs = Math.max(needMs, wait)
        }
      }

      if (needMs <= 0) break
      await sleep(needMs)
    }

    const now = Date.now()
    for (const w of this.windows) w.ts.push(now)
  }

  retryAfter(seconds: number) {
    this.blockedUntil = Date.now() + seconds * 1_000
  }
}

const limiter = new RateLimiter()

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function riotGet<T>(path: string): Promise<T | null> {
  if (!RIOT_API_KEY) return null

  for (let attempt = 0; attempt < 3; attempt++) {
    await limiter.wait()

    let status = 0
    let retryAfterHeader: string | undefined
    let body = ""

    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            host:    `${RIOT_REGION}.api.riotgames.com`,
            path,
            method:  "GET",
            headers: { "X-Riot-Token": RIOT_API_KEY },
          },
          (res) => {
            status           = res.statusCode ?? 0
            retryAfterHeader = res.headers["retry-after"] as string | undefined
            res.on("data", (c: Buffer) => { body += c.toString() })
            res.on("end", resolve)
          }
        )
        req.on("error", reject)
        req.setTimeout(8_000, () => { req.destroy(); reject(new Error("timeout")) })
        req.end()
      })
    } catch (e) {
      const wait = (attempt + 1) * 1_500
      console.warn(`[riot-api] Erro em ${path} (tentativa ${attempt + 1}): ${(e as Error).message} — retry em ${wait}ms`)
      await sleep(wait)
      continue
    }

    if (status === 200) {
      try { return JSON.parse(body) as T }
      catch { console.warn(`[riot-api] JSON inválido em ${path}`); return null }
    }

    if (status === 404) return null

    if (status === 429) {
      const wait = retryAfterHeader ? Number(retryAfterHeader) : (attempt + 1) * 2
      console.warn(`[riot-api] 429 em ${path} — aguardando ${wait}s`)
      limiter.retryAfter(wait)
      await sleep(wait * 1_000)
      continue
    }

    if (status >= 500) {
      const wait = (attempt + 1) * 1_500
      console.warn(`[riot-api] ${status} em ${path} (tentativa ${attempt + 1}) — retry em ${wait}ms`)
      await sleep(wait)
      continue
    }

    console.warn(`[riot-api] ${status} em ${path}`)
    return null
  }

  console.warn(`[riot-api] Esgotou retries para ${path}`)
  return null
}

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface RiotSummoner {
  puuid:         string
  id:            string   // encrypted summoner ID (needed for league entries)
  summonerLevel: number
  profileIconId: number
}

export interface RiotLeagueEntry {
  queueType:    string
  tier:         string
  rank:         string   // "I" | "II" | "III" | "IV"
  leaguePoints: number
  wins:         number
  losses:       number
}

export interface RiotPlayerData {
  level:    number | null
  tier:     string
  division: string   // mapped from rank
  lp:       number
  wins:     number
  losses:   number
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function riotGetSummoner(puuid: string): Promise<RiotSummoner | null> {
  return riotGet<RiotSummoner>(`/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`)
}

export async function riotGetLeagueEntries(summonerId: string): Promise<RiotLeagueEntry[]> {
  return (await riotGet<RiotLeagueEntry[]>(`/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`)) ?? []
}

// Fetches summoner level + ranked data for a PUUID in two sequential API calls.
export async function riotGetPlayerData(puuid: string): Promise<RiotPlayerData | null> {
  const summoner = await riotGetSummoner(puuid)
  if (!summoner) {
    console.warn(`[riot-api] Summoner não encontrado para ${puuid.slice(0, 8)}`)
    return null
  }

  const entries  = await riotGetLeagueEntries(summoner.id)
  const solo     = entries.find(e => e.queueType === "RANKED_SOLO_5x5")
  const flex     = entries.find(e => e.queueType === "RANKED_FLEX_SR")
  const q        = solo?.tier && solo.tier !== "UNRANKED" ? solo : flex

  return {
    level:    summoner.summonerLevel > 0 ? summoner.summonerLevel : null,
    tier:     q?.tier                  ?? "UNRANKED",
    division: q?.rank                  ?? "IV",   // Riot API field is "rank", not "division"
    lp:       q?.leaguePoints          ?? 0,
    wins:     Math.max(0, q?.wins      ?? 0),
    losses:   Math.max(0, q?.losses    ?? 0),
  }
}

export function isRiotApiAvailable(): boolean { return !!RIOT_API_KEY }

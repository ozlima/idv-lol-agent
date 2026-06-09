import { authenticate, connect, request, type Credentials } from "league-connect"

let credentials: Credentials | null = null
let activeGameflowSubscription = 0

export async function getLcuCredentials(): Promise<Credentials> {
  if (!credentials) credentials = await authenticate({ unsafe: true })
  return credentials
}

export async function lcuGet<T>(path: string): Promise<T> {
  const creds = await getLcuCredentials()
  const res = await request<never, T>({ method: "GET", url: path }, creds)
  return res.json()
}

export async function waitForLcu(): Promise<void> {
  console.log("[lcu] Aguardando cliente do LoL iniciar...")
  credentials = await authenticate({ awaitConnection: true, pollInterval: 3_000, unsafe: true })
  console.log(`[lcu] Cliente conectado â€” porta ${credentials.port}`)
}

async function reconnectGameflow(
  onPhaseChange: (phase: string) => void,
  onDisconnect?: () => void,
): Promise<void> {
  while (true) {
    try {
      await waitForLcu()
      const phase = await lcuGet<string>("/lol-gameflow/v1/gameflow-phase")
      await subscribeToGameflow(onPhaseChange, onDisconnect)
      onPhaseChange(phase)
      return
    } catch (e) {
      credentials = null
      console.warn("[lcu] Reconnect ainda nao pronto:", (e as Error).message)
      await new Promise(r => setTimeout(r, 5_000))
    }
  }
}

export async function subscribeToGameflow(
  onPhaseChange: (phase: string) => void,
  onDisconnect?: () => void,
): Promise<void> {
  const creds = await getLcuCredentials()
  const ws = await connect(creds)
  let reconnecting = false
  const subscriptionId = ++activeGameflowSubscription

  function scheduleReconnect(reason: string) {
    if (reconnecting) return
    if (subscriptionId !== activeGameflowSubscription) return
    reconnecting = true
    console.log(`[lcu] WebSocket desconectado (${reason}) - aguardando League Client voltar...`)
    credentials = null
    onDisconnect?.()
    setTimeout(() => {
      reconnectGameflow(onPhaseChange, onDisconnect).catch(e => {
        console.warn("[lcu] Reconnect falhou:", (e as Error).message)
      })
    }, 5_000)
  }

  ws.subscribe("/lol-gameflow/v1/gameflow-phase", (data: unknown) => {
    if (typeof data === "string") onPhaseChange(data)
  })

  ws.on("error", (e: Error) => {
    console.warn("[lcu] WebSocket erro:", e.message)
    scheduleReconnect("erro")
    try { ws.close() } catch {}
  })

  ws.on("close", () => {
    scheduleReconnect("close")
  })
}
export interface ChampSelectSession {
  localPlayerCellId: number
  actions?: Array<Array<{
    actorCellId: number
    championId: number
    completed: boolean
    id: number
    type: "ban" | "pick" | string
  }>>
  myTeam: Array<{
    cellId: number
    championId: number
    championPickIntent: number
    assignedPosition: string
    spell1Id: number
    spell2Id: number
    puuid: string
  }>
  theirTeam: Array<{
    cellId: number
    championId: number
    championPickIntent: number
    assignedPosition: string
  }>
  bans: {
    myTeamBans: number[]
    theirTeamBans: number[]
  }
  timer: { phase: string; adjustedTimeLeftInPhase: number }
}

export async function getChampSelectSession(): Promise<ChampSelectSession | null> {
  try {
    return await lcuGet<ChampSelectSession>("/lol-champ-select/v1/session")
  } catch {
    return null
  }
}

export interface LcuRunes {
  primaryStyleId: number
  subStyleId: number
  selectedPerkIds: number[]
  name: string
}

export async function getCurrentRunes(): Promise<LcuRunes | null> {
  try {
    return await lcuGet<LcuRunes>("/lol-perks/v1/currentpage")
  } catch {
    return null
  }
}

export interface LcuSummoner {
  puuid: string
  gameName: string
  tagLine: string
  summonerId?: number
  profileIconId?: number
}

export async function getCurrentSummoner(): Promise<LcuSummoner | null> {
  try {
    const res = await lcuGet<{ puuid: string; gameName: string; tagLine: string } & Record<string, unknown>>(
      "/lol-summoner/v1/current-summoner"
    )
    if (!res?.puuid) return null
    return { puuid: res.puuid, gameName: res.gameName, tagLine: res.tagLine }
  } catch {
    return null
  }
}

// â”€â”€â”€ Loading screen data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface GameflowParticipant {
  puuid:            string
  summonerId:       number
  summonerName:     string
  championId:       number
  selectedPosition: string   // "top" | "jungle" | "middle" | "bottom" | "utility" | ""
  assignedPosition: string   // alternativo dependendo da versÃ£o do client
  spell1Id:         number
  spell2Id:         number
  teamId:           number   // 100 = ORDER, 200 = CHAOS
  isBot:            boolean
}

export interface GameflowSession {
  gameData: {
    gameId:    number
    gameMode:  string
    queue:     { id: number; type: string }
    teamOne:   GameflowParticipant[]
    teamTwo:   GameflowParticipant[]
  }
  phase: string
}

export async function getGameflowSession(): Promise<GameflowSession | null> {
  try {
    return await lcuGet<GameflowSession>("/lol-gameflow/v1/session")
  } catch {
    return null
  }
}

export interface RankedQueueStats {
  tier:          string
  division:      string
  leaguePoints:  number
  wins:          number
  losses:        number
  hotStreak?:    boolean
  veteran?:      boolean
  freshBlood?:   boolean
  inactive?:     boolean
  miniSeriesProgress?: string
}

export interface ChampionMastery {
  championId:    number
  championLevel: number
  championPoints: number
  lastPlayTime:  number
}

export async function getChampionMastery(puuid: string, championId: number): Promise<ChampionMastery | null> {
  if (!championId) return null
  try {
    return await lcuGet<ChampionMastery>(
      `/lol-champion-mastery/v4/champion-masteries/by-puuid/${puuid}/by-champion/${championId}`
    )
  } catch {
    return null
  }
}

export async function getRecentMatchResults(puuid: string, count = 10): Promise<Array<{ win: boolean; championId: number }>> {
  try {
    type Res = { games?: { games?: Array<{ participants?: Array<{ stats?: { win?: boolean }; championId?: number }> }> } }
    const res = await lcuGet<Res>(
      `/lol-match-history/v1/products/lol/${puuid}/matches?begIndex=0&endIndex=${count - 1}`
    )
    return (res?.games?.games ?? []).map(g => ({
      win:        !!(g.participants?.[0]?.stats?.win),
      championId: g.participants?.[0]?.championId ?? 0,
    }))
  } catch {
    return []
  }
}

export interface RankedStats {
  queueMap: Record<string, RankedQueueStats>
}

export async function getRankedStats(puuid: string): Promise<RankedStats | null> {
  try {
    return await lcuGet<RankedStats>(`/lol-ranked/v1/ranked-stats/${puuid}`)
  } catch {
    return null
  }
}

export interface SummonerProfile {
  puuid:          string
  summonerLevel:  number
  profileIconId:  number
  gameName:       string
  tagLine:        string
}

export async function getSummonerByPuuid(puuid: string): Promise<SummonerProfile | null> {
  try {
    return await lcuGet<SummonerProfile>(`/lol-summoner/v1/summoners/by-puuid/${puuid}`)
  } catch {
    return null
  }
}

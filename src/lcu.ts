import { authenticate, connect, request, type Credentials } from "league-connect"

let credentials: Credentials | null = null

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
  console.log(`[lcu] Cliente conectado — porta ${credentials.port}`)
}

export async function subscribeToGameflow(
  onPhaseChange: (phase: string) => void,
): Promise<void> {
  const creds = await getLcuCredentials()
  const ws = await connect(creds)

  ws.subscribe("/lol-gameflow/v1/gameflow-phase", (data: unknown) => {
    if (typeof data === "string") onPhaseChange(data)
  })

  ws.on("close", () => {
    console.log("[lcu] WebSocket desconectado — reconectando em 5s...")
    credentials = null
    setTimeout(() => subscribeToGameflow(onPhaseChange), 5_000)
  })
}

export interface ChampSelectSession {
  localPlayerCellId: number
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

// ─── Loading screen data ──────────────────────────────────────────────────────

export interface GameflowParticipant {
  puuid:            string
  summonerId:       number
  summonerName:     string
  championId:       number
  selectedPosition: string   // "top" | "jungle" | "middle" | "bottom" | "utility" | ""
  assignedPosition: string   // alternativo dependendo da versão do client
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
  tier:          string   // "IRON" | "BRONZE" | ... | "MASTER" | "UNRANKED"
  division:      string   // "I" | "II" | "III" | "IV"
  leaguePoints:  number
  wins:          number
  losses:        number
  miniSeriesProgress?: string
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

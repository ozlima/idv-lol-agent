import https from "https"

const agent = new https.Agent({ rejectUnauthorized: false })
const BASE_HOST = "127.0.0.1"
const BASE_PORT = 2999

function lcFetch<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: BASE_HOST, port: BASE_PORT, path, method: "GET", agent },
      (res) => {
        let raw = ""
        res.on("data", (chunk: Buffer) => { raw += chunk.toString() })
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Live Client ${res.statusCode}`))
          } else {
            try { resolve(JSON.parse(raw) as T) }
            catch (e) { reject(e) }
          }
        })
      }
    )
    req.on("error", reject)
    req.end()
  })
}

export interface LivePlayer {
  summonerName: string
  championName: string
  team: "ORDER" | "CHAOS"
  position: string
  isDead: boolean
  respawnTimer: number
  level: number
  scores: {
    kills: number
    deaths: number
    assists: number
    creepScore: number
    wardScore: number
  }
  items: Array<{ itemID: number; displayName: string; price: number; slot: number }>
}

export interface LiveGameEvent {
  EventID:      number
  EventName:    string
  EventTime:    number
  KillerName?:  string
  VictimName?:  string
  Assisters?:   string[]
  DragonType?:  string
  Stolen?:      string
  KillStreak?:  number
  Recipient?:   string
  TurretKilled?: string
  InhibKilled?:  string
  AcingTeam?:   string
  Acer?:        string
  Result?:      string
}

export interface AllGameData {
  activePlayer: {
    summonerName: string
    level: number          // diretamente em activePlayer, NÃO em championStats
    currentGold: number    // diretamente em activePlayer, NÃO em championStats
    championStats: {
      currentGold?: number  // duplicado, menos confiável — preferir activePlayer.currentGold
      health?: number
      maxHealth: number
      resourceValue?: number
      resourceMax?: number
      moveSpeed?: number
      attackDamage?: number
      abilityPower?: number
      armor?: number
      magicResist?: number
      attackSpeed?: number
      lifeSteal?: number
    }
    scores?: {              // ausente em alguns modos — usar allPlayers[me].scores
      kills: number
      deaths: number
      assists: number
      creepScore: number
      wardScore: number
    }
    abilities?: {
      Q?: { abilityLevel: number; displayName: string; id: string }
      W?: { abilityLevel: number; displayName: string; id: string }
      E?: { abilityLevel: number; displayName: string; id: string }
      R?: { abilityLevel: number; displayName: string; id: string }
    }
  }
  allPlayers: LivePlayer[]
  gameData: { gameTime: number; gameMode: string; mapName: string; mapNumber: number }
  events: { Events: LiveGameEvent[] }
}

export async function getAllGameData(): Promise<AllGameData | null> {
  try {
    return await lcFetch<AllGameData>("/liveclientdata/allgamedata")
  } catch (e) {
    console.warn("[live-client] getAllGameData falhou:", (e as Error).message ?? e)
    return null
  }
}

export async function getEventData(): Promise<LiveGameEvent[]> {
  try {
    const res = await lcFetch<{ Events: LiveGameEvent[] }>("/liveclientdata/eventdata")
    return res.Events ?? []
  } catch {
    return []
  }
}

export async function isGameRunning(): Promise<boolean> {
  try {
    await lcFetch("/liveclientdata/gamestats")
    return true
  } catch {
    return false
  }
}

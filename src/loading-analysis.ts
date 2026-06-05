import { getGameflowSession, getRankedStats, getSummonerByPuuid } from "./lcu.js"
import { publishEvent } from "./publisher.js"

// ─── MMR estimation ───────────────────────────────────────────────────────────
// Valores baseados na distribuição histórica do servidor BR1/NA1

const TIER_BASE: Record<string, number> = {
  IRON: 500, BRONZE: 850, SILVER: 1100, GOLD: 1400,
  PLATINUM: 1650, EMERALD: 1900, DIAMOND: 2150,
  MASTER: 2450, GRANDMASTER: 2700, CHALLENGER: 2900,
}

const DIV_OFFSET: Record<string, number> = { IV: 0, III: 75, II: 150, I: 225 }

function estimateMMR(tier: string, division: string, lp: number): number {
  const t = tier?.toUpperCase()
  const d = division?.toUpperCase()
  const base = TIER_BASE[t] ?? 800
  if (t === "MASTER" || t === "GRANDMASTER" || t === "CHALLENGER") {
    return base + Math.floor(lp * 0.4)
  }
  return base + (DIV_OFFSET[d] ?? 0) + Math.floor(lp * 0.75)
}

function eloLabel(tier: string, division: string, lp: number): string {
  const t = tier?.toUpperCase()
  if (t === "UNRANKED" || !t) return "Unranked"
  if (t === "MASTER" || t === "GRANDMASTER" || t === "CHALLENGER") return `${tier} ${lp} LP`
  return `${tier} ${division} ${lp} LP`
}

// ─── Position normalization ───────────────────────────────────────────────────

const POS_ALIASES: Record<string, string> = {
  top: "TOP", jungle: "JUNGLE", middle: "MID", mid: "MID",
  bottom: "BOT", bot: "BOT", utility: "SUPPORT", support: "SUPPORT",
  adc: "BOT", fill: "FILL", unselected: "",
}

function normalizePos(pos: string | undefined): string {
  if (!pos) return ""
  return POS_ALIASES[pos.toLowerCase()] ?? pos.toUpperCase()
}

// ─── Smurf heuristics ────────────────────────────────────────────────────────

interface SmurfFlag {
  code:    string
  label:   string
}

function detectSmurfFlags(
  level: number,
  mmr: number,
  wins: number,
  losses: number,
  isUnranked: boolean,
): SmurfFlag[] {
  const total = wins + losses
  const wr = total > 0 ? wins / total : 0
  const flags: SmurfFlag[] = []

  if (level > 0 && level < 60)
    flags.push({ code: "very_low_level", label: `Conta nível ${level}` })
  else if (level < 120 && mmr >= 1800)
    flags.push({ code: "low_level_high_elo", label: `Nível ${level} com elo alto` })

  if (!isUnranked && total < 40 && mmr >= 1500)
    flags.push({ code: "few_games_high_elo", label: `Só ${total} jogos rankeados` })

  if (total > 0 && total < 120 && wr >= 0.62)
    flags.push({ code: "high_wr", label: `${(wr * 100).toFixed(0)}% WR em ${total} jogos` })

  return flags
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeLoadingScreen(myPuuid: string): Promise<void> {
  console.log("[loading] Iniciando análise do loading screen...")

  const session = await getGameflowSession()
  if (!session) {
    console.warn("[loading] Sessão não disponível")
    return
  }

  const mode = session.gameData?.gameMode ?? ""
  const isRankedOrNormal = ["CLASSIC", "ARAM", "CHERRY"].includes(mode.toUpperCase()) ||
    session.gameData?.queue?.type?.includes("RANKED")

  const teamOne = session.gameData.teamOne ?? []
  const teamTwo = session.gameData.teamTwo ?? []
  const allParticipants = [...teamOne, ...teamTwo]

  if (allParticipants.length === 0) {
    console.warn("[loading] Nenhum participante encontrado na sessão")
    return
  }

  // Busca dados de todos os players em paralelo
  const playerData = await Promise.all(allParticipants.map(async (p) => {
    const puuid = p.puuid
    const [ranked, summoner] = await Promise.all([
      getRankedStats(puuid),
      getSummonerByPuuid(puuid),
    ])

    const solo = ranked?.queueMap?.["RANKED_SOLO_5x5"]
    const flex = ranked?.queueMap?.["RANKED_FLEX_SR"]
    // Usa solo Q se disponível, senão flex
    const q = solo?.tier && solo.tier !== "UNRANKED" ? solo : flex

    const tier    = q?.tier      ?? "UNRANKED"
    const division = q?.division ?? "IV"
    const lp      = q?.leaguePoints ?? 0
    const wins    = q?.wins    ?? 0
    const losses  = q?.losses  ?? 0
    const total   = wins + losses
    const wr      = total > 0 ? +(wins / total * 100).toFixed(1) : 0
    const isUnranked = !q || tier === "UNRANKED"
    const mmr     = isUnranked ? 800 : estimateMMR(tier, division, lp)
    const level   = summoner?.summonerLevel ?? 0

    const pos = normalizePos(p.selectedPosition || p.assignedPosition)
    const smurfFlags = detectSmurfFlags(level, mmr, wins, losses, isUnranked)

    const myTeamIds = teamOne.some(t => t.puuid === myPuuid)
      ? teamOne.map(t => t.puuid)
      : teamTwo.map(t => t.puuid)

    const displayName = p.summonerName ||
      (summoner?.gameName ? `${summoner.gameName}#${summoner.tagLine}` : puuid.slice(0, 8))

    return {
      puuid,
      isMe:             puuid === myPuuid,
      isAlly:           myTeamIds.includes(puuid),
      summonerName:     displayName,
      championId:       p.championId,
      assignedPosition: pos,
      spell1Id:         p.spell1Id,
      spell2Id:         p.spell2Id,
      teamId:           p.teamId,
      elo: { tier, division, lp, wins, losses, winRate: wr, totalGames: total, label: eloLabel(tier, division, lp) },
      mmr,
      level,
      smurfFlags,
      isUnranked,
    }
  }))

  const myTeam    = playerData.filter(p => p.isAlly)
  const enemyTeam = playerData.filter(p => !p.isAlly)

  const avgMmr = (team: typeof playerData) => {
    const valid = team.filter(p => p.mmr > 0)
    return valid.length ? Math.round(valid.reduce((s, p) => s + p.mmr, 0) / valid.length) : 0
  }

  const myTeamAvg    = avgMmr(myTeam)
  const enemyTeamAvg = avgMmr(enemyTeam)

  // Menor elo do time aliado
  const lowestEloPlayer = myTeam.length > 0
    ? myTeam.reduce((a, b) => a.mmr <= b.mmr ? a : b)
    : null

  // Autofill: qualquer jogador com nível de conta baixo que está em posição improvável
  // (refinamento: se a posição atribuída não é top 2 mais jogadas — não temos essa info via LCU sem Riot API)
  // Flag conservadora: spell Smite (11) em posição não-jungle = autofill? vice-versa
  const autofillSuspects = playerData.filter(p => {
    const pos = p.assignedPosition
    const hasSmite = p.spell1Id === 11 || p.spell2Id === 11
    // Jungle sem smite
    if (pos === "JUNGLE" && !hasSmite) return true
    // Smite fora da jungle
    if (pos !== "JUNGLE" && pos !== "" && hasSmite) return true
    return false
  })

  const allSmurfs = playerData.filter(p => p.smurfFlags.length > 0)

  const mapPlayer = (p: typeof playerData[0]) => ({
    summonerName:     p.summonerName,
    championId:       p.championId,
    assignedPosition: p.assignedPosition,
    spell1Id:         p.spell1Id,
    spell2Id:         p.spell2Id,
    elo:              p.elo,
    mmr:              p.mmr,
    level:            p.level,
    smurfFlags:       p.smurfFlags,
    isMe:             p.isMe,
  })

  await publishEvent(myPuuid, "loading_analysis", {
    gameMode: mode,
    myTeam:   myTeam.map(mapPlayer),
    enemyTeam: enemyTeam.map(mapPlayer),
    analysis: {
      myTeamAvgMmr:    myTeamAvg,
      enemyTeamAvgMmr: enemyTeamAvg,
      mmrDifference:   enemyTeamAvg - myTeamAvg,
      favoredTeam:     enemyTeamAvg > myTeamAvg ? "ENEMY" : "ALLY",
      lowestEloMyTeam: lowestEloPlayer ? {
        summonerName: lowestEloPlayer.summonerName,
        elo:          lowestEloPlayer.elo.label,
        mmr:          lowestEloPlayer.mmr,
      } : null,
      autofillSuspects: autofillSuspects.map(p => ({
        summonerName:     p.summonerName,
        assignedPosition: p.assignedPosition,
        spells:           [p.spell1Id, p.spell2Id],
        team:             p.isAlly ? "ALLY" : "ENEMY",
      })),
      smurfSuspects: allSmurfs.map(p => ({
        summonerName: p.summonerName,
        level:        p.level,
        mmr:          p.mmr,
        flags:        p.smurfFlags,
        team:         p.isAlly ? "ALLY" : "ENEMY",
      })),
    },
  })

  console.log(`[loading] Análise publicada — MMR: aliados ${myTeamAvg} × inimigos ${enemyTeamAvg}`)
}

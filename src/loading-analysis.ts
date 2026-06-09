import { getGameflowSession, getRankedStats, getSummonerByPuuid, getChampionMastery, getRecentMatchResults } from "./lcu.js"
import { publishEvent } from "./publisher.js"
import { riotGetPlayerData, riotGetRecentMatchResults, isRiotApiAvailable } from "./riot-api.js"

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

export interface LoadingAnalysisResult {
  expectedPlayers: number
  participantCount: number
  rankedCount: number
  summonerCount: number
  complete: boolean
}

interface SmurfFlag {
  code:    string
  label:   string
}

function detectSmurfFlags(
  level: number | null,
  mmr: number,
  wins: number,
  losses: number,
  isUnranked: boolean,
): SmurfFlag[] {
  const total = wins + losses
  const wr = total > 0 ? wins / total : 0
  const flags: SmurfFlag[] = []

  if (level !== null && level > 0 && level < 60)
    flags.push({ code: "very_low_level", label: `Conta nível ${level}` })
  else if (level !== null && level < 120 && mmr >= 1800)
    flags.push({ code: "low_level_high_elo", label: `Nível ${level} com elo alto` })

  if (!isUnranked && total < 40 && mmr >= 1500)
    flags.push({ code: "few_games_high_elo", label: `Só ${total} jogos rankeados` })

  if (total > 0 && total < 120 && wr >= 0.62)
    flags.push({ code: "high_wr", label: `${(wr * 100).toFixed(0)}% WR em ${total} jogos` })

  return flags
}

// ─── Recent streak ───────────────────────────────────────────────────────────

function computeStreak(matches: Array<{ win: boolean }>): { type: "win" | "loss"; count: number } | null {
  if (matches.length < 2) return null
  const first = matches[0].win
  let count = 0
  for (const m of matches) {
    if (m.win === first) count++
    else break
  }
  return count >= 2 ? { type: first ? "win" : "loss", count } : null
}

// ─── Main analysis ────────────────────────────────────────────────────────────

export async function analyzeLoadingScreen(myPuuid: string, attempt = 1): Promise<LoadingAnalysisResult> {
  console.log(`[loading] Iniciando analise do loading screen (tentativa ${attempt})...`)

  const session = await getGameflowSession()
  if (!session) {
    console.warn("[loading] Sessão não disponível")
    return { expectedPlayers: 10, participantCount: 0, rankedCount: 0, summonerCount: 0, complete: false }
  }

  const mode = session.gameData?.gameMode ?? ""
  const isRankedOrNormal = ["CLASSIC", "ARAM", "CHERRY"].includes(mode.toUpperCase()) ||
    session.gameData?.queue?.type?.includes("RANKED")

  const teamOne = session.gameData.teamOne ?? []
  const teamTwo = session.gameData.teamTwo ?? []
  const allParticipants = [...teamOne, ...teamTwo]

  if (allParticipants.length === 0) {
    console.warn("[loading] Nenhum participante encontrado na sessão")
    return { expectedPlayers: 10, participantCount: 0, rankedCount: 0, summonerCount: 0, complete: false }
  }

  // Busca dados de todos os players em paralelo
  const playerData = await Promise.all(allParticipants.map(async (p) => {
    const puuid = p.puuid
    const [ranked, summoner, mastery, lcuMatches] = await Promise.all([
      getRankedStats(puuid),
      getSummonerByPuuid(puuid),
      p.championId > 0 ? getChampionMastery(puuid, p.championId) : Promise.resolve(null),
      getRecentMatchResults(puuid, 10),
    ])

    // Riot API fallback for match history when LCU returns empty (retry is built into riotGetRecentMatchResults)
    let recentMatches = lcuMatches
    if (recentMatches.length === 0 && isRiotApiAvailable()) {
      console.log(`[loading] Histórico LCU vazio para ${puuid.slice(0, 8)} — tentando Riot API...`)
      recentMatches = await riotGetRecentMatchResults(puuid, 10)
    }

    const solo = ranked?.queueMap?.["RANKED_SOLO_5x5"]
    const flex = ranked?.queueMap?.["RANKED_FLEX_SR"]
    // Usa solo Q se disponível, senão flex
    const q = solo?.tier && solo.tier !== "UNRANKED" ? solo : flex

    const tier    = q?.tier      ?? "UNRANKED"
    const division = q?.division ?? "IV"
    const lp      = q?.leaguePoints ?? 0
    const wins    = Math.max(0, q?.wins   ?? 0)
    const losses  = Math.max(0, q?.losses ?? 0)
    const total   = wins + losses
    const rawWr   = total > 0 ? wins / total * 100 : 0
    const wr      = total > 0 ? +(Math.min(100, Math.max(0, rawWr)).toFixed(1)) : 0
    // LCU bug: sometimes returns wins from previous splits while losses reset to 0 for new split
    const wrSuspicious = losses === 0 && total >= 5
    if (wrSuspicious) console.warn(`[loading] WR suspeito para ${puuid.slice(0, 8)}: ${wins}W/${losses}L — LCU pode estar misturando splits`)
    const reliableWinRate = total > 0 && wins <= total && rawWr <= 100 && !wrSuspicious
    const isUnranked = !q || tier === "UNRANKED"
    const hasRankedData = !!q
    const mmr     = isUnranked ? 800 : estimateMMR(tier, division, lp)
    const level   = Number.isFinite(Number(summoner?.summonerLevel)) && Number(summoner?.summonerLevel) > 0
      ? Number(summoner?.summonerLevel)
      : null

    const pos         = normalizePos(p.assignedPosition || p.selectedPosition)
    const selectedNorm = normalizePos(p.selectedPosition)
    // autofill: both positions known, selected ≠ assigned, and player didn't queue as fill
    const autofill    = !!selectedNorm && !!pos && selectedNorm !== "FILL" && selectedNorm !== pos
    const smurfFlags  = detectSmurfFlags(level, mmr, wins, losses, isUnranked)

    const hotStreak       = q?.hotStreak ?? false
    const streak          = computeStreak(recentMatches)
    const masteryLevel    = mastery?.championLevel ?? null
    const champGamesRecent = recentMatches.filter(m => m.championId === p.championId).length
    // New on champion: mastery level 1-3 OR fewer than 3 games in last 10
    const newChampion     = (masteryLevel !== null && masteryLevel <= 3) ||
                            (recentMatches.length >= 8 && champGamesRecent < 3)

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
      championName:     null,
      assignedPosition: pos,
      selectedPosition: selectedNorm,
      autofill,
      spell1Id:         p.spell1Id,
      spell2Id:         p.spell2Id,
      teamId:           p.teamId,
      elo: { tier, division, lp, wins, losses, winRate: wr, totalGames: total, reliableWinRate, label: eloLabel(tier, division, lp) },
      mmr,
      level,
      smurfFlags,
      isUnranked,
      hasRankedData,
      hasSummonerData: !!summoner,
      hotStreak,
      streak,
      masteryLevel,
      newChampion,
    }
  }))

  // ─── Riot API fallback — dados incompletos OU WR suspeito (LCU split bug) ──
  const needsFallback = playerData.filter(p => p.level === null || !p.hasRankedData || !p.elo.reliableWinRate)
  if (needsFallback.length > 0) {
    if (isRiotApiAvailable()) {
      console.log(`[loading] ${needsFallback.length} jogador(es) com dados incompletos/suspeitos — tentando Riot API...`)
      for (const p of needsFallback) {
        const idx      = playerData.indexOf(p)
        const riotData = await riotGetPlayerData(p.puuid)
        if (!riotData) continue

        const level    = riotData.level ?? p.level
        const useRiot  = riotData.tier !== "UNRANKED"
        const tier     = useRiot ? riotData.tier     : p.elo.tier
        const division = useRiot ? riotData.division : p.elo.division
        const lp       = useRiot ? riotData.lp       : p.elo.lp
        const wins     = useRiot ? riotData.wins     : p.elo.wins
        const losses   = useRiot ? riotData.losses   : p.elo.losses
        const total    = wins + losses
        const rawWr    = total > 0 ? wins / total * 100 : 0
        const wr       = total > 0 ? +(Math.min(100, Math.max(0, rawWr)).toFixed(1)) : 0
        const reliableWinRate = total > 0 && wins <= total && rawWr <= 100 && !(losses === 0 && total >= 5)
        const isUnranked = tier === "UNRANKED"
        const mmr      = isUnranked ? 800 : estimateMMR(tier, division, lp)
        const smurfFlags = detectSmurfFlags(level, mmr, wins, losses, isUnranked)

        playerData[idx] = {
          ...p,
          level,
          elo: { tier, division, lp, wins, losses, winRate: wr, totalGames: total, reliableWinRate, label: eloLabel(tier, division, lp) },
          mmr,
          smurfFlags,
          isUnranked,
          hasRankedData:   useRiot || p.hasRankedData,
          hasSummonerData: riotData.level !== null || p.hasSummonerData,
        }
        console.log(`[loading] Riot API fallback OK para ${p.summonerName}${!p.elo.reliableWinRate ? " (WR corrigida)" : ""}`)
      }
    } else {
      console.log(`[loading] ${needsFallback.length} jogador(es) com dados incompletos/suspeitos — RIOT_API_KEY não configurado, sem fallback`)
    }
  }

  const myTeam    = playerData.filter(p => p.isAlly)
  const enemyTeam = playerData.filter(p => !p.isAlly)

  const avgMmr = (team: typeof playerData) => {
    const valid = team.filter(p => p.mmr > 0)
    return valid.length ? Math.round(valid.reduce((s, p) => s + p.mmr, 0) / valid.length) : 0
  }

  const myTeamAvg    = avgMmr(myTeam)
  const enemyTeamAvg = avgMmr(enemyTeam)
  const expectedPlayers = 10
  const rankedCount = playerData.filter(p => p.hasRankedData).length
  const summonerCount = playerData.filter(p => p.hasSummonerData).length
  const complete = playerData.length >= expectedPlayers

  // Menor elo do time aliado
  const lowestEloPlayer = myTeam.length > 0
    ? myTeam.reduce((a, b) => a.mmr <= b.mmr ? a : b)
    : null
  const highestEloMyTeam = myTeam.length > 0
    ? myTeam.reduce((a, b) => a.mmr >= b.mmr ? a : b)
    : null
  const lowestEloEnemyTeam = enemyTeam.length > 0
    ? enemyTeam.reduce((a, b) => a.mmr <= b.mmr ? a : b)
    : null
  const highestEloEnemyTeam = enemyTeam.length > 0
    ? enemyTeam.reduce((a, b) => a.mmr >= b.mmr ? a : b)
    : null

  const autofillSuspects = playerData.filter(p => p.autofill)

  const allSmurfs = playerData.filter(p => p.smurfFlags.length > 0)

  const mapEloSpot = (p: typeof playerData[0] | null) => p ? ({
    puuid:            p.puuid,
    summonerName:     p.summonerName,
    championId:       p.championId,
    championName:     p.championName,
    assignedPosition: p.assignedPosition,
    elo:              p.elo.label,
    mmr:              p.mmr,
    level:            p.level,
  }) : null

  const mapPlayer = (p: typeof playerData[0]) => ({
    puuid:            p.puuid,
    summonerName:     p.summonerName,
    championId:       p.championId,
    championName:     p.championName,
    assignedPosition: p.assignedPosition,
    selectedPosition: p.selectedPosition,
    autofill:         p.autofill,
    spell1Id:         p.spell1Id,
    spell2Id:         p.spell2Id,
    elo:              p.elo,
    mmr:              p.mmr,
    level:            p.level,
    smurfFlags:       p.smurfFlags,
    isMe:             p.isMe,
    hotStreak:        p.hotStreak,
    streak:           p.streak,
    masteryLevel:     p.masteryLevel,
    newChampion:      p.newChampion,
  })

  await publishEvent(myPuuid, "loading_analysis", {
    gameMode: mode,
    attempt,
    completeness: {
      expectedPlayers,
      participantCount: playerData.length,
      rankedCount,
      summonerCount,
      complete,
    },
    myTeam:   myTeam.map(mapPlayer),
    enemyTeam: enemyTeam.map(mapPlayer),
    analysis: {
      myTeamAvgMmr:    myTeamAvg,
      enemyTeamAvgMmr: enemyTeamAvg,
      mmrDifference:   enemyTeamAvg - myTeamAvg,
      favoredTeam:     enemyTeamAvg > myTeamAvg ? "ENEMY" : "ALLY",
      highestEloMyTeam: mapEloSpot(highestEloMyTeam),
      lowestEloMyTeam: mapEloSpot(lowestEloPlayer),
      highestEloEnemyTeam: mapEloSpot(highestEloEnemyTeam),
      lowestEloEnemyTeam: mapEloSpot(lowestEloEnemyTeam),
      autofillSuspects: autofillSuspects.map(p => ({
        summonerName:     p.summonerName,
        assignedPosition: p.assignedPosition,
        selectedPosition: p.selectedPosition,
        spells:           [p.spell1Id, p.spell2Id],
        team:             p.isAlly ? "ALLY" : "ENEMY",
      })),
      smurfSuspects: allSmurfs.map(p => ({
        puuid:        p.puuid,
        summonerName: p.summonerName,
        championId:   p.championId,
        championName: p.championName,
        level:        p.level,
        mmr:          p.mmr,
        flags:        p.smurfFlags,
        team:         p.isAlly ? "ALLY" : "ENEMY",
      })),
    },
  })

  console.log(`[loading] Analise publicada - ${playerData.length}/${expectedPlayers} jogadores, ranked ${rankedCount}/${playerData.length}, MMR: aliados ${myTeamAvg} x inimigos ${enemyTeamAvg}`)

  return {
    expectedPlayers,
    participantCount: playerData.length,
    rankedCount,
    summonerCount,
    complete,
  }
}

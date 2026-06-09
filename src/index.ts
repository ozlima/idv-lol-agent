import { execSync } from "child_process"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { createClient, type RealtimeChannel } from "@supabase/supabase-js"
import { waitForLcu, subscribeToGameflow, getChampSelectSession, getCurrentSummoner, getCurrentRunes, lcuGet } from "./lcu.js"
import { getAllGameData, isGameRunning, type AllGameData, type LiveGameEvent } from "./live-client.js"
import { publishEvent } from "./publisher.js"
import { analyzeLoadingScreen, type LoadingAnalysisResult } from "./loading-analysis.js"

function readGitCommit(): string {
  try { return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim() }
  catch { return "unknown" }
}
const AGENT_VERSION = readGitCommit()

let champMap: Map<number, string> | null = null
let champMapLastAttempt = 0

async function getChampName(id: number): Promise<string> {
  if (!champMap && Date.now() - champMapLastAttempt > 30_000) {
    champMapLastAttempt = Date.now()
    try {
      const res = await fetch("https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-summary.json")
      if (res.ok) {
        const data = await res.json() as Array<{ id: number; name: string }>
        champMap = new Map(data.map(c => [c.id, c.name]))
        console.log(`[champ-map] Carregados ${champMap.size} campeões`)
      }
    } catch (e) {
      console.warn("[champ-map] Falha ao carregar — retry em 30s:", (e as Error).message)
    }
  }
  return champMap?.get(id) ?? `ID ${id}`
}

let itemPrices: Map<number, number> | null = null
let itemPricesLastAttempt = 0

async function getItemPrice(itemId: number): Promise<number> {
  if (!itemPrices && Date.now() - itemPricesLastAttempt > 30_000) {
    itemPricesLastAttempt = Date.now()
    try {
      const verRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      const versions = await verRes.json() as string[]
      const ver = versions[0]
      const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`)
      if (res.ok) {
        const data = await res.json() as { data: Record<string, { gold: { total: number } }> }
        itemPrices = new Map(Object.entries(data.data).map(([id, item]) => [Number(id), item.gold.total]))
        console.log(`[item-prices] Carregados ${itemPrices.size} itens (patch ${ver})`)
      }
    } catch (e) {
      console.warn("[item-prices] Falha ao carregar DDragon — retry em 30s:", (e as Error).message)
    }
  }
  return itemPrices?.get(itemId) ?? 0
}

function calcNetWorth(items: Array<{ itemID: number }>): Promise<number> {
  return Promise.all(items.map(i => getItemPrice(i.itemID)))
    .then(prices => prices.reduce((sum, price) => sum + price, 0))
}

type GamePhase =
  | "None" | "Lobby" | "Matchmaking" | "ReadyCheck"
  | "ChampSelect" | "GameStart" | "InProgress"
  | "WaitingForStats" | "PreEndOfGame" | "EndOfGame" | "TerminatedInError" | "LoLClosed"

// â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let currentPhase: GamePhase = "None"
let myPuuid: string | null = null
let myGameName: string | null = null

// Presence
let presenceChannel: RealtimeChannel | null = null
let presenceMeta: { puuid: string; gameName: string; tagLine: string; version: string } | null = null
let lastPublishedPresencePhase = ""

async function updatePresence(phase: string, force = false) {
  if (!presenceChannel || !presenceMeta) return
  if (!force && phase === lastPublishedPresencePhase) return

  await presenceChannel.track({
    ...presenceMeta,
    phase,
    since: new Date().toISOString(),
  }).then(() => {
    lastPublishedPresencePhase = phase
  }).catch(() => null)
}

// Champ select state
let champSelectPollInterval: ReturnType<typeof setInterval> | null = null
let lastHoverChampId = 0
let champSelectSent = false
let lastChampSelectFingerprint = ""

// In-game state
let updateInterval:    ReturnType<typeof setInterval> | null = null
let eventPollInterval: ReturnType<typeof setInterval> | null = null
let lastEventId = -1
let lastItemsFingerprint = ""
let lastKnownGameTime = 0
let gameEndSent = false
let loadingAnalysisRunId = 0

// â”€â”€â”€ Champ Select â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function startChampSelectPolling() {
  if (champSelectPollInterval) return
  lastHoverChampId = 0
  champSelectSent = false
  lastChampSelectFingerprint = ""
  champSelectPollInterval = setInterval(async () => {
    const session = await getChampSelectSession()
    if (session) await handleChampSelectSession(session)
  }, 2_000)
  console.log("[agent] Champ select polling iniciado")
}

function stopChampSelectPolling() {
  if (champSelectPollInterval) {
    clearInterval(champSelectPollInterval)
    champSelectPollInterval = null
  }
}

function uniquePositive(ids: number[]) {
  return [...new Set(ids.filter(id => Number.isFinite(id) && id > 0))]
}

function champSelectBanIds(session: Awaited<ReturnType<typeof getChampSelectSession>>) {
  if (!session) return { myTeam: [] as number[], enemyTeam: [] as number[] }

  const myCellIds = new Set((session.myTeam ?? []).map(p => p.cellId))
  const theirCellIds = new Set((session.theirTeam ?? []).map(p => p.cellId))
  const myTeam = [...(session.bans?.myTeamBans ?? [])]
  const enemyTeam = [...(session.bans?.theirTeamBans ?? [])]

  for (const actionGroup of session.actions ?? []) {
    for (const action of actionGroup) {
      if (action.type !== "ban" || !action.completed || action.championId <= 0) continue
      if (myCellIds.has(action.actorCellId)) myTeam.push(action.championId)
      else if (theirCellIds.has(action.actorCellId)) enemyTeam.push(action.championId)
    }
  }

  return {
    myTeam: uniquePositive(myTeam),
    enemyTeam: uniquePositive(enemyTeam),
  }
}

async function handleChampSelectSession(session: Awaited<ReturnType<typeof getChampSelectSession>>) {
  if (!session || !myPuuid || !Array.isArray(session.myTeam) || !Array.isArray(session.theirTeam)) return

  const me = session.myTeam.find(p => p.cellId === session.localPlayerCellId)
  if (!me) return
  await publishChampSelectState(session)

  // Hover detectado (antes do lock)
  const hoverId = me.championPickIntent
  if (hoverId > 0 && hoverId !== lastHoverChampId) {
    lastHoverChampId = hoverId
    const champName = await getChampName(hoverId)
    await publishEvent(myPuuid, "champ_hover", {
      championId:       hoverId,
      championName:     champName,
      position:         me.assignedPosition,
      spell1Id:         me.spell1Id,
      spell2Id:         me.spell2Id,
      isJungle:         me.spell1Id === 11 || me.spell2Id === 11,
      phase:            session.timer.phase,
      timeLeftInPhase:  Math.round(session.timer.adjustedTimeLeftInPhase),
    })
  }

  // Finalization â€” composiÃ§Ã£o completa confirmada
  if (session.timer.phase === "FINALIZATION" && !champSelectSent) {
    champSelectSent = true
    const runes = await getCurrentRunes().catch(() => null)
    const banIds = champSelectBanIds(session)
    const myChampName = await getChampName(me.championId)

    await publishEvent(myPuuid, "champ_select_complete", {
      myChampionId:   me.championId,
      myChampionName: myChampName,
      myPosition:     me.assignedPosition,
      spell1Id:       me.spell1Id,
      spell2Id:       me.spell2Id,
      isJungle:       me.spell1Id === 11 || me.spell2Id === 11,
      runes: runes ? {
        primaryStyleId:  runes.primaryStyleId,
        subStyleId:      runes.subStyleId,
        selectedPerkIds: runes.selectedPerkIds,
        name:            runes.name,
      } : null,
      myTeam: await Promise.all(session.myTeam.map(async p => ({
        championId:   p.championId,
        championName: await getChampName(p.championId),
        position:     p.assignedPosition,
        spell1Id:     p.spell1Id,
        spell2Id:     p.spell2Id,
        isJungle:     p.spell1Id === 11 || p.spell2Id === 11,
        puuid:        p.puuid,
      }))),
      enemyTeam: await Promise.all(session.theirTeam.map(async p => ({
        championId:   p.championId,
        championName: p.championId > 0 ? await getChampName(p.championId) : null,
        position:     p.assignedPosition,
      }))),
      bans: {
        myTeam:       await Promise.all(banIds.myTeam.map(id => getChampName(id))),
        enemyTeam:    await Promise.all(banIds.enemyTeam.map(id => getChampName(id))),
        myTeamIds:    banIds.myTeam,
        enemyTeamIds: banIds.enemyTeam,
      },
    })
  }
}

// â”€â”€â”€ In-game â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function startGameTracking() {
  if (updateInterval) return
  if (!myPuuid) return

  lastEventId = -1
  lastItemsFingerprint = ""
  lastKnownGameTime = 0
  gameEndSent = false
  console.log("[agent] Aguardando Live Client API...")

  let ready = false
  for (let i = 0; i < 30; i++) {
    if (await isGameRunning()) { ready = true; break }
    await new Promise(r => setTimeout(r, 3_000))
  }
  if (!ready) { console.warn("[agent] Live Client API nÃ£o respondeu"); return }

  console.log("[agent] Live Client conectado â€” tracking iniciado")

  const testData = await getAllGameData()
  console.log("[agent] allgamedata:", testData ? `OK â€” ${testData.allPlayers.length} jogadores` : "FALHOU (null)")
  if (!testData) return

  await sendGameUpdate("game_start")

  // Kill/objetivo + item changes a cada 5s
  eventPollInterval = setInterval(pollGameEvents, 5_000)

  // Stats completas a cada 30s
  updateInterval = setInterval(() => sendGameUpdate("game_update"), 30_000)
}

function stopGameTracking() {
  const hadTracking = !!updateInterval || !!eventPollInterval
  if (updateInterval)    { clearInterval(updateInterval);    updateInterval    = null }
  if (eventPollInterval) { clearInterval(eventPollInterval); eventPollInterval = null }
  if (hadTracking) console.log("[agent] Tracking encerrado")
}

async function sendScoreboard(data?: AllGameData) {
  if (!myPuuid) return
  const d = data ?? await getAllGameData()
  if (!d) return

  const players = await Promise.all(d.allPlayers.map(async p => ({
    summonerName: p.summonerName,
    championName: p.championName,
    team:         p.team,
    summonerSpells: {
      spellOne: p.summonerSpells?.summonerSpellOne?.displayName ?? p.summonerSpells?.summonerSpellOne?.rawDisplayName,
      spellTwo: p.summonerSpells?.summonerSpellTwo?.displayName ?? p.summonerSpells?.summonerSpellTwo?.rawDisplayName,
    },
    level:        p.level,
    kills:        p.scores?.kills      ?? 0,
    deaths:       p.scores?.deaths     ?? 0,
    assists:      p.scores?.assists    ?? 0,
    cs:           p.scores?.creepScore ?? 0,
    wardScore:    p.scores?.wardScore  ?? 0,
    items:        await Promise.all((p.items ?? []).map(async i => ({ id: i.itemID, name: i.displayName, price: await getItemPrice(i.itemID) }))),
    netWorth:     await calcNetWorth(p.items ?? []),
    isMe:         matchesMe(p.summonerName),
  })))

  const order = players.filter(p => p.team === "ORDER")
  const chaos = players.filter(p => p.team === "CHAOS")
  const teamGold = (team: typeof order) => team.reduce((sum, p) => sum + p.netWorth, 0)
  const orderGold = teamGold(order)
  const chaosGold = teamGold(chaos)

  await publishEvent(myPuuid, "scoreboard", {
    gameTime:   Math.floor(d.gameData.gameTime),
    teamGold: {
      order:      orderGold,
      chaos:      chaosGold,
      difference: Math.abs(orderGold - chaosGold),
      leading:    orderGold >= chaosGold ? "ORDER" : "CHAOS",
    },
    players,
  })
}

async function publishChampSelectState(session: NonNullable<Awaited<ReturnType<typeof getChampSelectSession>>>) {
  if (!myPuuid) return
  const banIds = champSelectBanIds(session)
  const fingerprint = JSON.stringify({
    phase: session.timer.phase,
    myTeam: session.myTeam.map(p => [p.cellId, p.championId, p.championPickIntent, p.assignedPosition, p.spell1Id, p.spell2Id]),
    enemyTeam: session.theirTeam.map(p => [p.cellId, p.championId, p.championPickIntent, p.assignedPosition]),
    bans: banIds,
  })
  if (fingerprint === lastChampSelectFingerprint) return
  lastChampSelectFingerprint = fingerprint

  await publishEvent(myPuuid, "champ_select_state", {
    phase: session.timer.phase,
    timeLeftInPhase: Math.round(session.timer.adjustedTimeLeftInPhase),
    myTeam: await Promise.all(session.myTeam.map(async p => ({
      cellId: p.cellId,
      championId: p.championId,
      championName: p.championId > 0 ? await getChampName(p.championId) : null,
      pickIntentId: p.championPickIntent,
      pickIntentName: p.championPickIntent > 0 ? await getChampName(p.championPickIntent) : null,
      position: p.assignedPosition,
      spell1Id: p.spell1Id,
      spell2Id: p.spell2Id,
      isJungle: p.spell1Id === 11 || p.spell2Id === 11,
      puuid: p.puuid,
      isMe: p.cellId === session.localPlayerCellId,
    }))),
    enemyTeam: await Promise.all(session.theirTeam.map(async p => ({
      cellId: p.cellId,
      championId: p.championId,
      championName: p.championId > 0 ? await getChampName(p.championId) : null,
      pickIntentId: p.championPickIntent,
      pickIntentName: p.championPickIntent > 0 ? await getChampName(p.championPickIntent) : null,
      position: p.assignedPosition,
    }))),
    bans: {
      myTeam: await Promise.all(banIds.myTeam.map(id => getChampName(id))),
      enemyTeam: await Promise.all(banIds.enemyTeam.map(id => getChampName(id))),
      myTeamIds: banIds.myTeam,
      enemyTeamIds: banIds.enemyTeam,
    },
  })
}

async function sendGameUpdate(type: "game_start" | "game_update") {
  if (!myPuuid) return
  const data = await getAllGameData()
  if (!data) { console.warn(`[agent] sendGameUpdate(${type}): sem dados do Live Client`); return }
  lastKnownGameTime = Math.floor(data.gameData.gameTime)

  const ap = data.activePlayer
  const allPlayers = data.allPlayers
  const order = allPlayers.filter(p => p.team === "ORDER")
  const chaos = allPlayers.filter(p => p.team === "CHAOS")

  const teamKills = (team: typeof order) => team.reduce((s, p) => s + (p.scores?.kills ?? 0), 0)
  const teamCS    = (team: typeof order) => team.reduce((s, p) => s + (p.scores?.creepScore ?? 0), 0)

  const gameTime = Math.floor(data.gameData?.gameTime ?? 0)
  const apStats  = ap.championStats

  // KDA/CS vÃªm de allPlayers (mais confiÃ¡vel que activePlayer.scores)
  const meInAll = allPlayers.find(p => matchesMe(p.summonerName))
  const kills     = meInAll?.scores?.kills      ?? ap.scores?.kills      ?? 0
  const deaths    = meInAll?.scores?.deaths     ?? ap.scores?.deaths     ?? 0
  const assists   = meInAll?.scores?.assists    ?? ap.scores?.assists    ?? 0
  const cs        = meInAll?.scores?.creepScore ?? ap.scores?.creepScore ?? 0
  const wardScore = meInAll?.scores?.wardScore  ?? ap.scores?.wardScore  ?? 0

  // level e currentGold ficam diretamente em activePlayer
  const level = ap.level ?? meInAll?.level ?? 0
  const gold  = Math.floor(ap.currentGold ?? apStats?.currentGold ?? 0)

  const cspm = gameTime > 0 ? +((cs / gameTime) * 60).toFixed(1) : 0
  const myTeamForKp = order.find(p => matchesMe(p.summonerName)) ? order : chaos
  const teamK = teamKills(myTeamForKp)
  const kp = teamK > 0 ? +(((kills + assists) / teamK) * 100).toFixed(0) : 0

  if (type === "game_update") await sendScoreboard(data)

  await publishEvent(myPuuid, type, {
    gameTime,
    gameMode: data.gameData?.gameMode,
    me: {
      summonerName: ap.summonerName,
      kills, deaths, assists, cs, cspm,
      wardScore,
      gold, level,
      maxHp: Math.round(apStats?.maxHealth ?? 0),
      killParticipation: kp,
      abilities: {
        Q: ap.abilities?.Q?.abilityLevel ?? 0,
        W: ap.abilities?.W?.abilityLevel ?? 0,
        E: ap.abilities?.E?.abilityLevel ?? 0,
        R: ap.abilities?.R?.abilityLevel ?? 0,
      },
    },
    score:  { order: teamKills(order), chaos: teamKills(chaos) },
    teamCS: { order: teamCS(order),    chaos: teamCS(chaos) },
    allPlayers: allPlayers.map(p => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team:         p.team,
      summonerSpells: {
        spellOne: p.summonerSpells?.summonerSpellOne?.displayName ?? p.summonerSpells?.summonerSpellOne?.rawDisplayName,
        spellTwo: p.summonerSpells?.summonerSpellTwo?.displayName ?? p.summonerSpells?.summonerSpellTwo?.rawDisplayName,
      },
      level:        p.level,
      isDead:       p.isDead,
      kills:        p.scores?.kills      ?? 0,
      deaths:       p.scores?.deaths     ?? 0,
      assists:      p.scores?.assists    ?? 0,
      cs:           p.scores?.creepScore ?? 0,
      wardScore:    p.scores?.wardScore  ?? 0,
      items:        p.items?.map(i => i.displayName) ?? [],
    })),
  })
}

function matchesMe(summonerName: string): boolean {
  if (!myGameName) return false
  // Strip "#Tag" suffix before comparing — avoids false-positive on enemy with similar prefix
  return summonerName.split('#')[0].toLowerCase() === myGameName.toLowerCase()
}

async function pollGameEvents() {
  if (!myPuuid) return

  const data = await getAllGameData()
  if (!data) return
  lastKnownGameTime = Math.floor(data.gameData.gameTime)

  // Detecta mudanÃ§a de itens â€” fingerprint de todos os itens de todos os jogadores
  const fingerprint = data.allPlayers
    .map(p => `${p.summonerName}:${p.items.map(i => i.itemID).join(",")}`)
    .join("|")

  if (fingerprint !== lastItemsFingerprint) {
    lastItemsFingerprint = fingerprint
    if (lastItemsFingerprint !== "") {
      // Itens mudaram â€” publica scoreboard atualizado imediatamente
      await sendScoreboard(data)
    }
  }

  // Processa eventos novos (kills, objetivos, etc.)
  const newEvents = (data.events?.Events ?? []).filter(e => e.EventID > lastEventId)
  if (newEvents.length === 0) return

  lastEventId = Math.max(...newEvents.map(e => e.EventID))
  for (const ev of newEvents) {
    await publishRawLolEvent(ev)
    await processGameEvent(ev)
  }
}

async function publishRawLolEvent(ev: LiveGameEvent) {
  if (!myPuuid) return
  await publishEvent(myPuuid, "raw_lol_event", {
    eventId: ev.EventID,
    eventName: ev.EventName,
    eventTime: ev.EventTime,
    raw: ev,
  })
}
async function processGameEvent(ev: LiveGameEvent) {
  if (!myPuuid) return

  const isMe = (name?: string) => !!name && matchesMe(name)

  switch (ev.EventName) {
    case "FirstBlood":
      await publishEvent(myPuuid, "first_blood", {
        recipient: ev.Recipient,
        isMe:      isMe(ev.Recipient),
        eventTime: ev.EventTime,
      })
      break

    case "ChampionKill":
      await publishEvent(myPuuid, "kill", {
        killer:        ev.KillerName,
        victim:        ev.VictimName,
        assisters:     ev.Assisters ?? [],
        isMeKilling:   isMe(ev.KillerName),
        isMeDying:     isMe(ev.VictimName),
        isMeAssisting: (ev.Assisters ?? []).some(isMe),
        eventTime:     ev.EventTime,
      })
      break

    case "Multikill":
      if (isMe(ev.KillerName)) {
        const labels: Record<number, string> = { 2: "Double Kill", 3: "Triple Kill", 4: "Quadra Kill", 5: "Penta Kill" }
        await publishEvent(myPuuid, "multikill", {
          killer:     ev.KillerName,
          killStreak: ev.KillStreak,
          label:      labels[ev.KillStreak ?? 2] ?? `${ev.KillStreak} kills`,
          eventTime:  ev.EventTime,
        })
      }
      break

    case "DragonKill":
      await publishEvent(myPuuid, "objective", {
        type:       "dragon",
        dragonType: ev.DragonType,
        killer:     ev.KillerName,
        stolen:     ev.Stolen === "True",
        eventTime:  ev.EventTime,
      })
      break

    case "BaronKill":
      await publishEvent(myPuuid, "objective", {
        type:      "baron",
        killer:    ev.KillerName,
        stolen:    ev.Stolen === "True",
        eventTime: ev.EventTime,
      })
      break

    case "HeraldKill":
      await publishEvent(myPuuid, "objective", {
        type:      "herald",
        killer:    ev.KillerName,
        eventTime: ev.EventTime,
      })
      break

    case "VoidGrubKill":
      await publishEvent(myPuuid, "objective", {
        type:      "void_grub",
        killer:    ev.KillerName,
        stolen:    ev.Stolen === "True",
        eventTime: ev.EventTime,
      })
      break

    case "AtakhanKill":
      await publishEvent(myPuuid, "objective", {
        type:      "atakhan",
        killer:    ev.KillerName,
        stolen:    ev.Stolen === "True",
        eventTime: ev.EventTime,
      })
      break

    case "TurretKilled":
      await publishEvent(myPuuid, "objective", {
        type:      "tower",
        killer:    ev.KillerName,
        turretId:  ev.TurretKilled,
        eventTime: ev.EventTime,
      })
      break

    case "InhibitorKilled":
      await publishEvent(myPuuid, "objective", {
        type:      "inhibitor",
        killer:    ev.KillerName,
        eventTime: ev.EventTime,
      })
      break

    case "Ace":
      await publishEvent(myPuuid, "objective", {
        type:      "ace",
        acingTeam: ev.AcingTeam,
        acer:      ev.Acer,
        eventTime: ev.EventTime,
      })
      break
  }
}

async function handleGameEnd() {
  if (!myPuuid || gameEndSent) return
  if (!updateInterval && !eventPollInterval && lastKnownGameTime <= 0) return
  gameEndSent = true
  const data = await getAllGameData()
  const gameTime = data ? Math.floor(data.gameData.gameTime) : lastKnownGameTime
  lastKnownGameTime = 0

  await publishEvent(myPuuid, "game_end", {
    gameTime,
    allPlayers: data?.allPlayers.map(p => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team:         p.team,
      kills:        p.scores.kills,
      deaths:       p.scores.deaths,
      assists:      p.scores.assists,
      cs:           p.scores.creepScore,
    })) ?? [],
  })
}

// â”€â”€â”€ Phase handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Auto-update
let codeUpdateInProgress = false

function run(command: string) {
  return execSync(command, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function isGitCheckout(): boolean {
  try {
    return run("git rev-parse --is-inside-work-tree") === "true"
  } catch {
    return false
  }
}

function getUpstreamRef(): string {
  try {
    return run("git rev-parse --abbrev-ref --symbolic-full-name @{u}")
  } catch {
    return "origin/master"
  }
}

function restartAgent(isUnderPM2: boolean) {
  setTimeout(() => {
    if (isUnderPM2) {
      execSync("pm2 restart idv-lol-agent --update-env", { stdio: "inherit" })
    } else {
      process.exit(42)
    }
  }, 3_000)
}

function refreshBootstrapLauncher() {
  const source = join(process.cwd(), "IDV-Tracker.bat")
  const target = join(dirname(process.cwd()), "IDV-Tracker.bat")
  if (!existsSync(source)) return

  try {
    copyFileSync(source, target)
    console.log("[agent] Launcher atualizado")
  } catch (e) {
    console.warn("[agent] Nao foi possivel atualizar o launcher:", (e as Error).message)
  }
}

function applyCodeUpdate(reason: string, isUnderPM2: boolean): boolean {
  if (codeUpdateInProgress) return false
  codeUpdateInProgress = true

  try {
    console.log(`[agent] Update detectado (${reason}) - baixando codigo novo...`)
    execSync("git pull --ff-only", { stdio: "inherit", cwd: process.cwd() })
    refreshBootstrapLauncher()
    execSync("npm install --silent", { stdio: "pipe", cwd: process.cwd() })
    console.log("[agent] Codigo atualizado. Reiniciando em 3s...")
    restartAgent(isUnderPM2)
    return true
  } catch (e) {
    codeUpdateInProgress = false
    console.error("[agent] Falha ao atualizar:", (e as Error).message)
    return false
  }
}

function getLocalZipVersion(): string {
  try {
    return readFileSync(join(process.cwd(), ".idv-version"), "utf8").trim()
  } catch {
    return ""
  }
}

async function getRemoteCommitSha(): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/repos/ozlima/idv-lol-agent/commits/master", {
      headers: { "User-Agent": "idv-lol-agent" },
    })
    if (!res.ok) return null
    const data = await res.json() as { sha?: string }
    return data.sha ?? null
  } catch {
    return null
  }
}

function applyZipCodeUpdate(remoteSha: string, isUnderPM2: boolean): boolean {
  if (codeUpdateInProgress) return false
  codeUpdateInProgress = true

  try {
    console.log("[agent] Update detectado (zip GitHub) - baixando codigo novo...")
    const appRoot = dirname(process.cwd())
    const zipPath = join(appRoot, "agent-update.zip")
    const tmpDir = join(appRoot, "agent-update-src")

    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; ` +
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ` +
      `if (Test-Path '${zipPath}') { Remove-Item -LiteralPath '${zipPath}' -Force }; ` +
      `if (Test-Path '${tmpDir}') { Remove-Item -LiteralPath '${tmpDir}' -Recurse -Force }; ` +
      `Invoke-WebRequest 'https://github.com/ozlima/idv-lol-agent/archive/refs/heads/master.zip' -OutFile '${zipPath}'; ` +
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force; ` +
      `Copy-Item -Path (Join-Path '${tmpDir}' 'idv-lol-agent-master\\*') -Destination '${process.cwd()}' -Recurse -Force; ` +
      `Remove-Item -LiteralPath '${zipPath}' -Force; ` +
      `Remove-Item -LiteralPath '${tmpDir}' -Recurse -Force"`,
      { stdio: "inherit", cwd: process.cwd() }
    )

    refreshBootstrapLauncher()
    writeFileSync(join(process.cwd(), ".idv-version"), `${remoteSha}\n`, "utf8")
    execSync("npm install --silent", { stdio: "pipe", cwd: process.cwd() })
    console.log("[agent] Codigo atualizado. Reiniciando em 3s...")
    restartAgent(isUnderPM2)
    return true
  } catch (e) {
    codeUpdateInProgress = false
    console.error("[agent] Falha ao atualizar via zip:", (e as Error).message)
    return false
  }
}

async function checkForCodeUpdate(isUnderPM2: boolean) {
  if (codeUpdateInProgress) return

  if (!isGitCheckout()) {
    const remoteSha = await getRemoteCommitSha()
    if (remoteSha && remoteSha !== getLocalZipVersion()) {
      applyZipCodeUpdate(remoteSha, isUnderPM2)
    }
    return
  }

  try {
    const upstream = getUpstreamRef()
    execSync("git fetch --quiet origin", { stdio: "pipe", cwd: process.cwd() })

    const localHead = run("git rev-parse HEAD")
    const remoteHead = run(`git rev-parse ${upstream}`)

    if (localHead && remoteHead && localHead !== remoteHead) {
      applyCodeUpdate(`git ${upstream}`, isUnderPM2)
    }
  } catch (e) {
    console.warn("[agent] Nao foi possivel checar update:", (e as Error).message)
  }
}

function startAutoUpdateChecker(isUnderPM2: boolean) {
  void checkForCodeUpdate(isUnderPM2)
  setInterval(() => void checkForCodeUpdate(isUnderPM2), 5 * 60_000)
  console.log("[agent] Auto-update ativo (GitHub a cada 5min)")
}

async function markLeagueClientClosed() {
  if (currentPhase === "LoLClosed") return
  const prev = currentPhase
  currentPhase = "LoLClosed"
  stopChampSelectPolling()
  stopGameTracking()
  champSelectSent = false
  lastHoverChampId = 0
  console.log(`[agent] League Client desconectado: ${prev} -> LoLClosed`)
  await updatePresence("LoLClosed", true)
}

function shouldRetryLoadingAnalysis(result: LoadingAnalysisResult) {
  if (result.complete) return false
  if (result.participantCount < result.expectedPlayers) return true
  return result.rankedCount < Math.max(1, Math.floor(result.participantCount * 0.7))
}

function scheduleLoadingAnalysisRetries(puuid: string) {
  const runId = ++loadingAnalysisRunId
  const delays = [0, 5_000, 15_000, 30_000, 60_000]

  delays.forEach((delay, index) => {
    setTimeout(async () => {
      if (runId !== loadingAnalysisRunId) return
      if (!["GameStart", "InProgress"].includes(currentPhase)) return

      try {
        const result = await analyzeLoadingScreen(puuid, index + 1)
        if (!shouldRetryLoadingAnalysis(result)) loadingAnalysisRunId++
      } catch (e) {
        console.warn("[loading] Erro:", (e as Error).message)
      }
    }, delay)
  })
}

async function onPhaseChange(phase: string) {
  if (phase === currentPhase) return
  const prev = currentPhase
  currentPhase = phase as GamePhase
  console.log(`[agent] Fase: ${prev} â†’ ${phase}`)
  if (myPuuid) {
    await publishEvent(myPuuid, "gameflow_phase", {
      previousPhase: prev,
      phase,
      at: new Date().toISOString(),
    })
  }

  if (phase === "ChampSelect") {
    startChampSelectPolling()
  }

  if (phase === "GameStart") {
    stopChampSelectPolling()
    if (myPuuid) scheduleLoadingAnalysisRetries(myPuuid)
    await startGameTracking()
  }

  if (phase === "InProgress" && !updateInterval) {
    // Jogo jÃ¡ estava em andamento quando o agent iniciou
    await startGameTracking()
  }

  if (phase === "WaitingForStats" || phase === "PreEndOfGame" || phase === "EndOfGame" || phase === "TerminatedInError") {
    loadingAnalysisRunId++
    await handleGameEnd()
    stopChampSelectPolling()
    stopGameTracking()
  }

  if (phase === "None" || phase === "Lobby") {
    loadingAnalysisRunId++
    stopChampSelectPolling()
    stopGameTracking()
    champSelectSent = false
    lastHoverChampId = 0
  }

  void updatePresence(phase, prev === "LoLClosed")
}

async function waitForCurrentSummoner() {
  let attempts = 0
  while (true) {
    const summoner = await getCurrentSummoner()
    if (summoner) return summoner

    attempts++
    if (attempts === 1 || attempts % 10 === 0) {
      console.warn("[agent] Invocador ainda indisponivel; aguardando League Client estabilizar...")
    }
    await new Promise(r => setTimeout(r, 3_000))
  }
}
// â”€â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  console.log("[agent] IDV LoL Agent iniciando...")
  console.log("[agent] Abra o League Client para o agent ficar online.")

  const isUnderPM2 = !!process.env.PM2_HOME
  startAutoUpdateChecker(isUnderPM2)

  await waitForLcu()

  const summoner = await waitForCurrentSummoner()

  myPuuid    = summoner.puuid
  myGameName = summoner.gameName
  console.log(`[agent] Jogador: ${summoner.gameName}#${summoner.tagLine} (${summoner.puuid.slice(0, 8)}...)`)

  // Captura fase atual ao iniciar
  try {
    const phase = await lcuGet<string>("/lol-gameflow/v1/gameflow-phase")
    await onPhaseChange(phase)
  } catch (e) {
    console.error("[agent] Erro ao processar fase inicial:", e)
  }

  await subscribeToGameflow(onPhaseChange, () => void markLeagueClientClosed())
  console.log("[agent] Aguardando eventos do LoL...")

  // â”€â”€ PresenÃ§a online â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const presenceClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)
  presenceChannel = presenceClient.channel("idv-agent-presence")
  presenceMeta    = { puuid: myPuuid!, gameName: myGameName!, tagLine: summoner.tagLine, version: AGENT_VERSION }

  presenceChannel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await updatePresence(currentPhase)
      console.log("[agent] PresenÃ§a online ativa")
    }
  })

  setInterval(() => updatePresence(currentPhase), 60_000)

  // â”€â”€ Canal de admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const adminClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)
  adminClient
    .channel("idv-agent-admin")
    .on("broadcast", { event: "update" }, () => {
      if (isGitCheckout()) {
        applyCodeUpdate("comando admin", isUnderPM2)
      } else {
        void getRemoteCommitSha().then(sha => {
          if (sha) applyZipCodeUpdate(sha, isUnderPM2)
          else console.warn("[agent] Broadcast update: nao foi possivel obter SHA remoto")
        })
      }
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[agent] Canal admin conectado")
    })
}

main().catch(e => { console.error("[agent] Erro fatal:", e); process.exit(1) })

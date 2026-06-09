import http from "http"
import { execSync } from "child_process"
import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { generatePostGameAnalysis, type EndGameSnapshot } from "./post-game-analysis.js"

config()

function readGitCommit(): string {
  try { return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore","pipe","pipe"] }).trim() }
  catch { return "unknown" }
}
const CURRENT_VERSION = readGitCommit()

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!
const PORT = Number(process.env.WATCH_UI_PORT ?? 4317)

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL ou SUPABASE_ANON_KEY nao definidos no .env")
  process.exit(1)
}

type EventRow = {
  id?: number
  puuid: string
  event_type: string
  data: Record<string, unknown>
  created_at?: string
}

type PresenceState = {
  puuid: string
  gameName: string
  tagLine: string
  version?: string
  phase: string
  since: string
}

const MAX_EVENTS = 80
const HYDRATE_EVENTS = 2000
const MIN_POST_GAME_ANALYSIS_SECONDS = 600

let analysisEnabled = true

type PlayerDashboardState = {
  puuid: string
  latestLoading: Record<string, unknown> | null
  latestChampSelect: Record<string, unknown> | null
  latestGameflow: Record<string, unknown> | null
  latestScoreboard: Record<string, unknown> | null
  latestScoreboardAt: string | null
  goldHistory: Array<{ gameTime: number; signedGold: number }>
  playerFingerprint: Record<string, string>
  playerLastSeenAt: Record<string, number>
  latestGameUpdate: Record<string, unknown> | null
  latestGameUpdateAt: string | null
  latestGameEnd: EventRow | null
  latestPostGameAnalysis: Record<string, unknown> | null
  events: EventRow[]
  // Stable gold diff: only updates when all 10 players have bought since last settle
  stableGoldDiff: number | null
  goldDiffPending: boolean
  // True only after game_start event fires (loading screen does not count)
  gameStarted: boolean
}

// Server-side only settle tracking (Set is not JSON-serialisable — keep out of state)
type SettleTracking = {
  itemFingerprints: Record<string, string>
  boughtSinceSettle: Set<string>
  lastSettleGameTime: number
}
const settleTracking = new Map<string, SettleTracking>()

function getSettleTracking(puuid: string): SettleTracking {
  let s = settleTracking.get(puuid)
  if (!s) {
    s = { itemFingerprints: {}, boughtSinceSettle: new Set(), lastSettleGameTime: 0 }
    settleTracking.set(puuid, s)
  }
  return s
}

function resetSettleTracking(puuid: string) {
  const s = getSettleTracking(puuid)
  s.itemFingerprints = {}
  s.boughtSinceSettle.clear()
  s.lastSettleGameTime = 0
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const onlineUsers = new Map<string, PresenceState>()
const playerStates = new Map<string, PlayerDashboardState>()
const pendingPostGameAnalyses = new Set<string>()

const clients = new Set<http.ServerResponse>()

function nowIso() {
  return new Date().toISOString()
}

function mins(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function playerState(puuid: string): PlayerDashboardState {
  let state = playerStates.get(puuid)
  if (!state) {
    state = {
      puuid,
      latestLoading: null,
      latestChampSelect: null,
      latestGameflow: null,
      latestScoreboard: null,
      latestScoreboardAt: null,
      goldHistory: [],
      playerFingerprint: {},
      playerLastSeenAt: {},
      latestGameUpdate: null,
      latestGameUpdateAt: null,
      latestGameEnd: null,
      latestPostGameAnalysis: null,
      events: [],
      stableGoldDiff: null,
      goldDiffPending: false,
      gameStarted: false,
    }
    playerStates.set(puuid, state)
  }
  return state
}

function pushEvent(row: EventRow, realtime = false) {
  if (row.event_type === "raw_lol_event") return
  const event = { ...row, created_at: row.created_at ?? nowIso() }
  const state = playerState(row.puuid)
  state.events.unshift(event)
  state.events.splice(MAX_EVENTS)

  if (row.event_type === "champ_select_state" || row.event_type === "champ_select_complete") {
    state.latestChampSelect = row.data
  }

  if (row.event_type === "loading_analysis") {
    if (loadingQuality(row.data) >= loadingQuality(state.latestLoading)) {
      state.latestLoading = row.data
    }
  } else if (row.event_type === "gameflow_phase") {
    const newPhase  = String(asRecord(row.data).phase  ?? "")
    const prevPhase = String(asRecord(state.latestGameflow).phase ?? "")
    state.latestGameflow = row.data

    if (newPhase === "ChampSelect" && prevPhase !== "ChampSelect") {
      state.latestChampSelect     = null
      state.latestLoading         = null
      state.latestScoreboard      = null
      state.latestScoreboardAt    = null
      state.goldHistory           = []
      state.playerFingerprint     = {}
      state.playerLastSeenAt      = {}
      state.latestGameUpdate      = null
      state.latestGameUpdateAt    = null
      state.latestGameEnd         = null
      state.latestPostGameAnalysis = null
      state.events = []
      state.stableGoldDiff        = null
      state.goldDiffPending       = false
      state.gameStarted           = false
      resetSettleTracking(row.puuid)
      console.log(`[watch-ui] Nova fila detectada para ${row.puuid.slice(0, 8)} — estado limpo`)
    }
  } else if (row.event_type === "scoreboard") {
    if (isReliableScoreboard(row.data)) {
      updatePlayerFingerprints(state, row.data)
      updateItemFingerprints(state.puuid, row.data)
      state.latestScoreboard = row.data
      state.latestScoreboardAt = event.created_at
      if (allPlayersUpdated(row.data) && allPlayersRecent(state, row.data)) {
        const point = goldPoint(row.data)
        if (point) {
          const last = state.goldHistory[state.goldHistory.length - 1]
          if (last && point.gameTime < last.gameTime - 60) state.goldHistory = []
          if (!state.goldHistory.some(p => p.gameTime === point.gameTime)) {
            state.goldHistory.push(point)
            state.goldHistory = state.goldHistory.slice(-120)
          }
        }
        // Settle: only update displayed gold diff when all 10 players bought, or 2-min fallback
        const ss = getSettleTracking(state.puuid)
        const gameTime = num(row.data.gameTime) ?? 0
        const allBought = ss.boughtSinceSettle.size >= 10
        const fallback  = gameTime - ss.lastSettleGameTime >= 120
        if (allBought || fallback) {
          const gp = goldPoint(row.data)
          state.stableGoldDiff  = gp ? gp.signedGold : state.stableGoldDiff
          state.goldDiffPending = false
          ss.boughtSinceSettle.clear()
          ss.lastSettleGameTime = gameTime
        } else {
          state.goldDiffPending = ss.boughtSinceSettle.size > 0
        }
      }
    }
  } else if (row.event_type === "game_update" || row.event_type === "game_start") {
    if (row.event_type === "game_start") {
      state.goldHistory = []
      state.playerFingerprint = {}
      state.playerLastSeenAt = {}
      resetSettleTracking(state.puuid)
      state.stableGoldDiff = null
      state.goldDiffPending = false
      state.gameStarted = true
    }
    state.latestGameUpdate = row.data
    state.latestGameUpdateAt = event.created_at
  } else if (row.event_type === "game_end") {
    state.gameStarted = false
    state.latestGameEnd = event
  } else if (row.event_type === "post_game_analysis") {
    state.latestPostGameAnalysis = row.data
  }

  broadcast()
  if (realtime && analysisEnabled && row.event_type === "game_end") void analyzeGameEnd(event)
}

function loadingQuality(data: Record<string, unknown> | null) {
  if (!data) return -1
  const completeness = asRecord(data.completeness)
  const participantCount = num(completeness.participantCount) ?? asList(data.myTeam).length + asList(data.enemyTeam).length
  const rankedCount = num(completeness.rankedCount) ?? 0
  const summonerCount = num(completeness.summonerCount) ?? 0
  const completeBonus = completeness.complete ? 1000 : 0
  return completeBonus + participantCount * 100 + rankedCount * 10 + summonerCount
}

async function hydrateEvents() {
  const { data, error } = await supabase
    .from("live_game_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(HYDRATE_EVENTS)

  if (error) {
    console.warn("[watch-ui] Nao foi possivel carregar eventos recentes:", error.message)
    return
  }

  for (const row of (data ?? []).reverse()) pushEvent(row as EventRow)
}

async function retryFailedPostGameAnalyses() {
  for (const state of playerStates.values()) {
    if (state.latestPostGameAnalysis?.status !== "erro") continue
    const gameEnd = state.latestGameEnd ?? state.events.find(e => e.event_type === "game_end")
    if (!gameEnd) continue
    console.log(`[watch-ui] Reprocessando analise pos-jogo com erro para ${state.puuid.slice(0, 8)}`)
    void analyzeGameEnd(gameEnd)
  }
}

function snapshot() {
  const players = [...playerStates.values()].map(state => ({
    ...state,
    presence: onlineUsers.get(state.puuid) ?? null,
  }))
  return {
    now: nowIso(),
    currentVersion: CURRENT_VERSION,
    analysisEnabled,
    onlineUsers: [...onlineUsers.values()],
    players,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(v => v && typeof v === "object") as Record<string, unknown>[] : []
}

function num(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function isReliableScoreboard(data: Record<string, unknown>) {
  const players = asList(data.players)
  const order = players.filter(p => p.team === "ORDER")
  const chaos = players.filter(p => p.team === "CHAOS")
  return order.length === 5 &&
    chaos.length === 5 &&
    players.every(p => Number.isFinite(Number(p.netWorth)))
}

function allPlayersUpdated(data: Record<string, unknown>) {
  const players = asList(data.players)
  return players.length === 10 && players.every(p => Number(p.netWorth) > 0)
}

function updatePlayerFingerprints(state: PlayerDashboardState, data: Record<string, unknown>) {
  const gameTime = num(data.gameTime) ?? 0
  for (const p of asList(data.players)) {
    const key = String(p.summonerName || p.championName || "")
    if (!key) continue
    const fp = `${num(p.cs) ?? 0}|${num(p.kills) ?? 0}|${num(p.level) ?? 0}|${num(p.netWorth) ?? 0}`
    if (state.playerFingerprint[key] !== fp) {
      state.playerFingerprint[key] = fp
      state.playerLastSeenAt[key] = gameTime
    }
  }
}

function allPlayersRecent(state: PlayerDashboardState, data: Record<string, unknown>, maxStaleSecs = 90) {
  const gameTime = num(data.gameTime)
  if (gameTime === null || gameTime < 120) return true
  const players = asList(data.players)
  return players.every(p => {
    const key = String(p.summonerName || p.championName || "")
    const lastSeen = state.playerLastSeenAt[key]
    return lastSeen !== undefined && (gameTime - lastSeen) <= maxStaleSecs
  })
}

function updateItemFingerprints(puuid: string, data: Record<string, unknown>) {
  const ss = getSettleTracking(puuid)
  for (const p of asList(data.players)) {
    const key = String(p.summonerName || p.championName || "")
    if (!key) continue
    const fp = asList(p.items).map(i => String(i.id ?? "")).filter(Boolean).sort().join(",")
    if (key in ss.itemFingerprints && ss.itemFingerprints[key] !== fp) {
      ss.boughtSinceSettle.add(key)
    }
    ss.itemFingerprints[key] = fp
  }
}

function goldPoint(data: Record<string, unknown>) {
  const players = asList(data.players)
  const me = players.find(p => p.isMe)
  const teamGold = asRecord(data.teamGold)
  const diff = num(teamGold.difference)
  const gameTime = num(data.gameTime)
  if (gameTime !== null && gameTime < 30) return null
  if (!me?.team || diff === null || gameTime === null) return null
  return {
    gameTime,
    signedGold: teamGold.leading === me.team ? diff : -diff,
  }
}

function findMePlayer(state: PlayerDashboardState) {
  const scoreboardPlayers = asList(state.latestScoreboard?.players)
  const scoreboardMe = scoreboardPlayers.find(p => p.isMe)
  const updateMe = asRecord(state.latestGameUpdate?.me)
  const updatePlayers = asList(state.latestGameUpdate?.allPlayers)
  const byName = updateMe.summonerName ? updatePlayers.find(p => p.summonerName === updateMe.summonerName) : null
  return { ...updateMe, ...asRecord(byName), ...asRecord(scoreboardMe) }
}

function gameEndKey(row: EventRow) {
  const state = playerState(row.puuid)
  const gameTime = num(row.data?.gameTime) ?? num(state.latestGameUpdate?.gameTime) ?? num(state.latestScoreboard?.gameTime) ?? 0
  const created = row.created_at ? Math.floor(new Date(row.created_at).getTime() / 60_000) : Date.now()
  return `${row.puuid}:${Math.floor(gameTime)}:${created}`
}

async function insertPostGameStatus(row: EventRow, status: string, extra: Record<string, unknown>) {
  const { error } = await supabase.from("live_game_events").insert({
    puuid: row.puuid,
    event_type: "post_game_analysis",
    data: { status, ...extra },
  })
  if (error) console.warn("[watch-ui] Falha ao gravar post_game_analysis:", error.message)
}

async function analyzeGameEnd(row: EventRow) {
  const key = gameEndKey(row)
  if (pendingPostGameAnalyses.has(key)) return
  pendingPostGameAnalyses.add(key)

  try {
    const state = playerState(row.puuid)
    const me = findMePlayer(state)
    const gameUpdate = state.latestGameUpdate ?? {}
    const endData = row.data ?? {}
    const duration = num(endData.gameTime) ?? num(gameUpdate?.gameTime) ?? num(state.latestScoreboard?.gameTime) ?? undefined

    if (!duration || duration < MIN_POST_GAME_ANALYSIS_SECONDS) {
      await insertPostGameStatus(row, "ignorado", {
        generatedAt: nowIso(),
        reason: "remake_or_short_game",
        detail: `Partida curta (${mins(duration ?? 0)}). Analise IA ignorada.`,
        duration,
      })
      return
    }

    await insertPostGameStatus(row, "gerando", { startedAt: nowIso(), duration })

    const snapshotData: EndGameSnapshot = {
      summonerName: String(me.summonerName || gameUpdate?.summonerName || ""),
      championName: String(me.championName || gameUpdate?.championName || ""),
      position: String(me.position || me.assignedPosition || ""),
      result: String(endData.result || gameUpdate?.result || ""),
      duration,
      me,
      score: asRecord(gameUpdate?.score),
      teamGold: asRecord(state.latestScoreboard?.teamGold),
      teamCS: asRecord(gameUpdate?.teamCS),
      loading: state.latestLoading,
      scoreboard: state.latestScoreboard,
      gameUpdate: state.latestGameUpdate,
      events: state.events
        .filter(e => e.event_type !== "post_game_analysis")
        .slice(0, 60)
        .map(e => ({ event_type: e.event_type, data: e.data, created_at: e.created_at })),
    }
    const analysis = await generatePostGameAnalysis(snapshotData)
    await insertPostGameStatus(row, "pronto", {
      generatedAt: nowIso(),
      summonerName: snapshotData.summonerName,
      championName: snapshotData.championName,
      duration: snapshotData.duration,
      analysis,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn("[watch-ui] Analise pos-jogo falhou:", message)
    await insertPostGameStatus(row, "erro", { generatedAt: nowIso(), error: message })
  } finally {
    pendingPostGameAnalyses.delete(key)
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const client of clients) client.write(payload)
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(data))
}

function html() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IDV Watch</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #171a1d;
      --panel-2: #1f2327;
      --line: #2c3338;
      --text: #ecf0f3;
      --muted: #97a1aa;
      --green: #42d27d;
      --red: #ff6b6b;
      --yellow: #f0c85a;
      --blue: #64a8ff;
      --cyan: #4fd2d5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, Segoe UI, Arial, sans-serif;
      letter-spacing: 0;
    }
    button, input { font: inherit; }
    .app { min-height: 100vh; display: flex; flex-direction: column; }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: #15181b;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 750; }
    .status { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--green); box-shadow: 0 0 0 3px rgba(66,210,125,.12); }
    .player-tabs {
      display: flex;
      gap: 8px;
      align-items: center;
      max-width: 56vw;
      overflow-x: auto;
      padding: 0 6px;
    }
    .player-tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 120px;
      max-width: 220px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #111417;
      color: var(--muted);
      cursor: pointer;
      white-space: nowrap;
    }
    .player-tab.active { color: var(--text); border-color: rgba(100,168,255,.65); background: rgba(100,168,255,.12); }
    .player-tab-name { overflow: hidden; text-overflow: ellipsis; font-weight: 800; }
    .player-tab-phase { color: var(--muted); font-size: 11px; }
    .ver-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; font-family: monospace; flex-shrink: 0; }
    .ver-badge.ok      { background: rgba(66,210,125,.18); color: var(--green); }
    .ver-badge.old     { background: rgba(255,200,0,.18);  color: var(--yellow); }
    .ver-badge.unknown { background: rgba(255,255,255,.08); color: var(--muted); }
    main {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(300px, 390px) minmax(460px, 1fr) minmax(300px, 390px);
      gap: 0;
      min-height: 0;
    }
    section {
      min-width: 0;
      padding: 14px;
      border-right: 1px solid var(--line);
      overflow: auto;
    }
    section:last-child { border-right: 0; }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 10px;
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      font-weight: 800;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 42px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-2);
    }
    .panel-title { font-weight: 800; font-size: 14px; }
    .panel-body { padding: 12px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metric {
      min-height: 64px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #14171a;
    }
    .metric label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .metric strong { font-size: 18px; }
    .mmr-compare {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      margin-bottom: 10px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(100,168,255,.08) 0%, rgba(255,107,107,.08) 100%);
      border: 1px solid rgba(255,255,255,.08);
    }
    .mmr-compare-team { display: flex; flex-direction: column; gap: 4px; }
    .mmr-compare-team.right { text-align: right; }
    .mmr-compare-tier { font-weight: 900; font-size: 22px; letter-spacing: -.5px; }
    .mmr-compare-mmr { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; }
    .mmr-compare-center { text-align: center; display: flex; flex-direction: column; gap: 4px; align-items: center; }
    .mmr-compare-vs { font-size: 11px; font-weight: 800; color: var(--muted); letter-spacing: 1px; }
    .mmr-compare-diff { font-size: 15px; font-weight: 800; }
    .game-result-banner {
      padding: 14px 16px; border-radius: 8px; margin-bottom: 10px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .game-result-banner.win  { background: linear-gradient(135deg, rgba(66,210,125,.12) 0%, rgba(66,210,125,.04) 100%); border: 1px solid rgba(66,210,125,.3); }
    .game-result-banner.lose { background: linear-gradient(135deg, rgba(255,107,107,.12) 0%, rgba(255,107,107,.04) 100%); border: 1px solid rgba(255,107,107,.3); }
    .game-result-banner.unknown { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); }
    .game-result-title { font-size: 26px; font-weight: 900; letter-spacing: -1px; text-align: center; }
    .game-result-duration { font-size: 11px; font-weight: 700; text-align: center; color: var(--muted); letter-spacing: .5px; text-transform: uppercase; margin-top: -4px; }
    .game-result-mvp-row { display: flex; gap: 8px; }
    .game-result-player-card {
      flex: 1; padding: 10px 12px; border-radius: 6px; background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.06); min-width: 0;
    }
    .game-result-player-card.mvp  { border-color: rgba(255,200,0,.3); background: rgba(255,200,0,.06); }
    .game-result-player-card.worst { border-color: rgba(255,107,107,.25); background: rgba(255,107,107,.05); }
    .game-result-player-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); margin-bottom: 4px; }
    .game-result-player-label.mvp   { color: #ffc800; }
    .game-result-player-label.worst { color: var(--red); }
    .game-result-player-name { font-size: 13px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .game-result-player-champ { font-size: 11px; color: var(--muted); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .game-result-player-kda { font-size: 12px; font-weight: 700; }
    .game-result-scoreboard { margin-top: 6px; }
    .game-result-scoreboard-header { display: flex; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); padding: 0 4px 4px; }
    .game-result-scoreboard-row { display: flex; align-items: center; padding: 4px; border-radius: 4px; font-size: 12px; gap: 4px; }
    .game-result-scoreboard-row:hover { background: rgba(255,255,255,.04); }
    .game-result-scoreboard-row.me { font-weight: 800; background: rgba(100,168,255,.07); }
    .game-result-scoreboard-row .col-name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .game-result-scoreboard-row .col-champ { width: 80px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
    .game-result-scoreboard-row .col-kda  { width: 70px; text-align: center; flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .game-result-scoreboard-row .col-cs   { width: 36px; text-align: right; color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .game-result-scoreboard-row .col-gold { width: 48px; text-align: right; color: var(--yellow); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .game-result-team-label { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; padding: 6px 4px 3px; color: var(--muted); }
    .gold-chart {
      position: relative;
      margin-top: 12px;
      height: 160px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0e1114;
      overflow-x: auto;
      overflow-y: hidden;
      cursor: crosshair;
      scrollbar-width: thin;
      scrollbar-color: #2c3338 #0e1114;
    }
    .gc-indicator {
      position: absolute;
      top: 0; bottom: 0;
      width: 1px;
      background: rgba(255,255,255,.28);
      pointer-events: none;
      display: none;
    }
    .gold-chart svg { display: block; min-width: 300px; width: 100%; height: 100%; }
    .gold-chart .area.blue { fill: rgba(100,168,255,.14); }
    .gold-chart .area.red  { fill: rgba(255,107,107,.14); }
    .gold-chart .line.blue { stroke: #64a8ff; }
    .gold-chart .line.red  { stroke: #ff6b6b; }
    .gold-chart .line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .gold-chart-label { fill: rgba(255,255,255,.35); font: 10px/1 Inter, Segoe UI, Arial, sans-serif; }
    .analysis-player { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    .analysis-player:last-child { border-bottom: 0; }
    .analysis-player.risk { padding: 8px; border-left: 3px solid var(--yellow); border-bottom: 0; margin-bottom: 4px; border-radius: 0 4px 4px 0; background: rgba(240,200,90,.06); }
    .ap-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ap-champ { font-weight: 850; }
    .ap-name { font-weight: 750; }
    .ap-sub-name { color: var(--muted); font-size: 11px; margin-top: 1px; }
    .risk-flags { color: var(--yellow); font-size: 11px; margin-top: 3px; }
    .alert-banner { padding: 14px 12px; text-align: center; font-weight: 800; font-size: 14px; color: var(--green); background: rgba(66,210,125,.07); border-radius: 6px; margin-bottom: 8px; }
    .alert-banner.end { color: var(--muted); background: rgba(255,255,255,.04); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    .row:last-child { border-bottom: 0; }
    .name { font-weight: 750; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; background: #252b30; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .pill.green { color: var(--green); background: rgba(66,210,125,.12); }
    .pill.red { color: var(--red); background: rgba(255,107,107,.12); }
    .pill.yellow { color: var(--yellow); background: rgba(240,200,90,.12); }
    .pill.blue { color: var(--blue); background: rgba(100,168,255,.12); }
    .champ-card {
      min-height: 72px;
      padding: 10px;
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .champ-card:last-child { border-bottom: 0; }
    .champ-card.high-gold {
      border-left: 3px solid var(--yellow);
      background: linear-gradient(90deg, rgba(240,200,90,.18), rgba(240,200,90,.045));
      box-shadow: inset 0 0 0 1px rgba(240,200,90,.18);
    }
    .champ-main { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .champ-name { font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .champ-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
    .ban-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .ban { min-height: 24px; padding: 4px 8px; border-radius: 6px; background: rgba(255,107,107,.12); color: var(--red); font-size: 12px; }
    .alert { padding: 10px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .alert:last-child { border-bottom: 0; }
    .alert.red { border-left: 3px solid var(--red); }
    .alert.yellow { border-left: 3px solid var(--yellow); }
    .alert.blue { border-left: 3px solid var(--blue); }
    .alert-title { font-weight: 850; }
    .alert-champ { font-weight: 850; font-size: 13px; }
    .alert-name  { color: var(--muted); font-size: 11px; margin-top: 1px; }
    .alert-msg   { font-size: 12px; margin-top: 4px; }
    .key {
      width: 34px;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      display: grid;
      place-items: center;
      color: var(--yellow);
      font-weight: 900;
      background: #202429;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 6px; border-bottom: 1px solid rgba(255,255,255,.07); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; font-weight: 800; }
    .event { padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.07); }
    .event-type { color: var(--cyan); font-weight: 800; }
    .event-detail { color: var(--muted); margin-top: 4px; font-size: 12px; line-height: 1.35; }
    .analysis-text { white-space: pre-wrap; line-height: 1.45; color: var(--text); font-size: 13px; }
    .analysis-list { margin: 10px 0 0; padding-left: 18px; color: var(--text); }
    .analysis-list li { margin: 5px 0; }
    .raw-ai {
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #111417;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.4 Consolas, "Courier New", monospace;
      max-height: 220px;
      overflow: auto;
    }
    .empty { color: var(--muted); padding: 14px 0; }
    @media (max-width: 1120px) {
      main { grid-template-columns: 1fr; }
      section { border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>IDV Watch</h1>
      <div id="player-tabs" class="player-tabs"></div>
      <div class="status"><span class="dot"></span><span id="conn">conectando</span><span id="clock"></span></div>
    </header>
    <main>
      <section>
        <div class="section-title"><span>Meu Time</span><span id="ally-count">0</span></div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Picks e Intencoes</span><span id="ally-phase" class="pill">-</span></div>
          <div class="panel-body" id="ally-team"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Bans</span></div>
          <div class="panel-body"><div id="ally-bans" class="ban-list"></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Elo e Risco</span><span id="ally-elo" class="pill blue">-</span></div>
          <div class="panel-body" id="ally-analysis"></div>
        </div>
      </section>
      <section>
        <div class="section-title"><span>Partida</span><span id="phase">-</span></div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Resumo</span><span id="game-time" class="pill">-</span></div>
          <div class="panel-body">
            <div id="game-result" style="display:none"></div>
            <div id="mmr-compare" class="mmr-compare" style="display:none"></div>
            <div class="grid-2">
              <div class="metric"><label>Placar</label><strong id="score">-</strong></div>
              <div class="metric"><label>CS Times</label><strong id="cs">-</strong></div>
              <div class="metric"><label id="gold-label">Gold Diff</label><strong id="gold">-</strong></div>
              <div class="metric"><label>Online</label><strong id="online">0</strong></div>
            </div>
            <div id="gold-chart" class="gold-chart"></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Alertas</span><span id="alert-count" class="pill yellow">0</span></div>
          <div class="panel-body" id="alerts"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Analise Pos-Jogo</span><span id="post-game-status" class="pill">aguardando</span><button id="toggle-analysis" class="pill" style="cursor:pointer;margin-left:auto;border:none" onclick="toggleAnalysis()">IA ✓</button></div>
          <div class="panel-body" id="post-game-analysis"><div class="empty">Aguardando fim da partida</div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Feed de Eventos</span><span id="event-count">0</span></div>
          <div class="panel-body" id="events"></div>
        </div>
      </section>
      <section>
        <div class="section-title"><span>Inimigos</span><span id="enemy-count">0</span></div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Picks e Intencoes</span><span id="enemy-phase" class="pill">-</span></div>
          <div class="panel-body" id="enemy-team"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Bans</span></div>
          <div class="panel-body"><div id="enemy-bans" class="ban-list"></div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Elo e Risco</span><span id="enemy-elo" class="pill red">-</span></div>
          <div class="panel-body" id="enemy-analysis"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    let state = null
    let selectedPuuid = ""
    let _gcData = null
    let _lastPhaseSeen = ""
    let _phaseAt = 0
    let _lastGameTimeSent = 0
    let _lastGameTimestampAt = 0
    const $ = (id) => document.getElementById(id)
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec || 0))
      return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0")
    }
    function mmrToEloLabel(mmr) {
      if (!mmr) return "?"
      const tiers = [
        ["Challenger", 2900], ["Grandmaster", 2700], ["Master", 2450],
        ["Diamond", 2150], ["Emerald", 1900], ["Platinum", 1650],
        ["Gold", 1400], ["Silver", 1100], ["Bronze", 850], ["Iron", 500],
      ]
      for (const [tier, base] of tiers) {
        if (mmr >= base) {
          if (tier === "Master" || tier === "Grandmaster" || tier === "Challenger") return tier
          const offset = mmr - base
          if (offset >= 225) return tier + " I"
          if (offset >= 150) return tier + " II"
          if (offset >= 75)  return tier + " III"
          return tier + " IV"
        }
      }
      return "Iron IV"
    }
    function toggleAnalysis() {
      fetch("/api/toggle-analysis", { method: "POST" }).catch(() => null)
    }

    function updateAnalysisToggle(enabled) {
      const btn = $("toggle-analysis")
      if (!btn) return
      btn.textContent = enabled ? "IA ✓" : "IA ✗"
      btn.style.background = enabled ? "rgba(66,210,125,.18)" : "rgba(255,107,107,.18)"
      btn.style.color = enabled ? "var(--green)" : "var(--red)"
    }

    // Tick rápido: só clock e timer — não toca em innerHTML para não destruir seleção de texto
    setInterval(() => {
      if (!state) return
      $("clock").textContent = new Date().toLocaleTimeString("pt-BR")
      const current = currentPlayerState(state)
      const gu = current?.latestGameUpdate || {}
      const gameStarted = !!current?.gameStarted
        || (!!current?.latestGameUpdate && !current?.latestGameEnd)
      const guGameTime = Number(gu.gameTime || 0)
      if (gameStarted && guGameTime > _lastGameTimeSent) { _lastGameTimeSent = guGameTime; _lastGameTimestampAt = Date.now() }
      if (!gameStarted) { _lastGameTimeSent = 0; _lastGameTimestampAt = 0 }
      const liveGameTime = gameStarted && _lastGameTimeSent > 0
        ? _lastGameTimeSent + (Date.now() - _lastGameTimestampAt) / 1000
        : 0
      $("game-time").textContent = liveGameTime > 0 ? fmt(liveGameTime) : "-"
    }, 1000)

    const es = new EventSource("/events")
    es.onopen = () => $("conn").textContent = "conectado"
    es.onerror = () => $("conn").textContent = "reconectando"
    es.onmessage = (ev) => {
      state = JSON.parse(ev.data)
      updateAnalysisToggle(state.analysisEnabled !== false)
      render(state)
    }

    function render(s) {
      const current = currentPlayerState(s)
      renderPlayerTabs(s, current)
      $("online").textContent = s.onlineUsers.length

      const phase = current?.latestGameflow?.phase || current?.presence?.phase || ""
      $("phase").textContent = phase || "-"
      if (phase !== _lastPhaseSeen) { _lastPhaseSeen = phase; _phaseAt = Date.now() }

      const gu = current?.latestGameUpdate || {}
      const score = gu.score || {}
      const cs = gu.teamCS || {}
      const sb = current?.latestScoreboard || {}
      const players = sb.players || []
      const me = players.find(p => p.isMe)
      const myTeam = me?.team

      const scoreL = Number.isFinite(score.order) ? (myTeam === "CHAOS" ? score.chaos : score.order) : null
      const scoreR = Number.isFinite(score.order) ? (myTeam === "CHAOS" ? score.order : score.chaos) : null
      $("score").textContent = scoreL !== null ? scoreL + " x " + scoreR : "-"

      const csL = Number.isFinite(cs.order) ? (myTeam === "CHAOS" ? cs.chaos : cs.order) : null
      const csR = Number.isFinite(cs.order) ? (myTeam === "CHAOS" ? cs.order : cs.chaos) : null
      $("cs").textContent = csL !== null ? csL + " x " + csR : "-"

      const stableGold = current?.stableGoldDiff
      const pending = current?.goldDiffPending === true
      const goldLabel = document.getElementById("gold-label")
      if (goldLabel) goldLabel.textContent = pending ? "Gold Diff ⏳" : "Gold Diff"
      $("gold").textContent = typeof stableGold === "number"
        ? (stableGold > 0 ? "+" : "") + stableGold.toLocaleString("pt-BR")
        : "-"
      renderGoldChart(current?.goldHistory || [])

      const gameStarted = !!current?.gameStarted || (!!current?.latestGameUpdate && !current?.latestGameEnd)
      const gameOver = !!current?.latestGameEnd && !gameStarted
      const clientClosed = phase === "LoLClosed"
      const showPanels = !gameOver && !clientClosed
      renderGameResult(gameOver ? current?.latestGameEnd : null)
      renderSidePanels(
        showPanels ? current?.latestChampSelect : null,
        showPanels ? current?.latestLoading : null,
        showPanels ? current?.latestScoreboard : null,
      )
      renderAlerts(current || {})
      renderPostGameAnalysis(current?.latestPostGameAnalysis)
      renderEvents(current?.events || [])
    }

    function currentPlayerState(s) {
      const players = s.players || []
      if (!players.length) return null
      if (!selectedPuuid || !players.some(p => p.puuid === selectedPuuid)) {
        const online = players.find(p => p.presence) || players[0]
        selectedPuuid = online?.puuid || ""
      }
      return players.find(p => p.puuid === selectedPuuid) || players[0]
    }

    function renderPlayerTabs(s, current) {
      const players = s.players || []
      const latest = s.currentVersion || ""
      $("player-tabs").innerHTML = players.map(p => {
        const presence = p.presence || {}
        const me = p.latestGameUpdate?.me || {}
        const name = presence.gameName ? presence.gameName + "#" + presence.tagLine : (me.summonerName || p.puuid.slice(0, 8))
        const phase = p.latestGameflow?.phase || presence.phase || "-"
        const active = current?.puuid === p.puuid ? " active" : ""
        const agentVer = presence.version || ""
        const verOk  = agentVer && latest && agentVer === latest
        const verOld = agentVer && latest && agentVer !== latest
        const verBadge = verOk
          ? '<span class="ver-badge ok" title="' + esc(agentVer) + '">' + esc(agentVer) + '</span>'
          : verOld
            ? '<span class="ver-badge old" title="desatualizado: ' + esc(agentVer) + ' (atual: ' + esc(latest) + ')">' + esc(agentVer) + ' ⚠</span>'
            : '<span class="ver-badge unknown" title="versao desconhecida — aguardando pull">?</span>'
        return '<button class="player-tab' + active + '" data-puuid="' + esc(p.puuid) + '"><span class="dot"></span><span class="player-tab-name">' + esc(name) + '</span>' + verBadge + '<span class="player-tab-phase">' + esc(phase) + '</span></button>'
      }).join("") || '<span class="sub">Nenhum agent com eventos ainda</span>'
      for (const btn of document.querySelectorAll(".player-tab")) {
        btn.onclick = () => {
          selectedPuuid = btn.dataset.puuid || ""
          render(state)
        }
      }
    }

    function renderGoldChart(points) {
      const el = $("gold-chart")
      const clean = (points || []).filter(p => Number.isFinite(Number(p.gameTime)) && Number.isFinite(Number(p.signedGold)))
      if (clean.length < 2) {
        el.innerHTML = '<div class="empty" style="padding:16px">Aguardando snapshots 5x5 para grafico de gold</div>'
        _gcData = null
        return
      }

      const W = 640, H = 160
      const padL = 38, padR = 10, padT = 16, padB = 16
      const cW = W - padL - padR, cH = H - padT - padB
      const mid = padT + cH / 2
      const minT = clean[0].gameTime, maxT = clean[clean.length - 1].gameTime
      const maxAbs = Math.max(1000, ...clean.map(p => Math.abs(Number(p.signedGold))))
      const xf = t => padL + ((t - minT) / Math.max(1, maxT - minT)) * cW
      const yf = g => mid - (g / maxAbs) * (cH / 2)
      const fmtK = v => v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(v))

      // Split into segments at each zero crossing
      const segs = []
      let seg = { pos: Number(clean[0].signedGold) >= 0, pts: [clean[0]] }
      for (let i = 1; i < clean.length; i++) {
        const a = clean[i - 1], b = clean[i]
        const ag = Number(a.signedGold), bg = Number(b.signedGold)
        if ((ag >= 0) !== (bg >= 0)) {
          const t = ag / (ag - bg)
          const cross = { gameTime: a.gameTime + t * (b.gameTime - a.gameTime), signedGold: 0 }
          seg.pts.push(cross)
          segs.push(seg)
          seg = { pos: bg >= 0, pts: [cross, b] }
        } else {
          seg.pts.push(b)
        }
      }
      segs.push(seg)

      const mkD = pts => pts.map((p, i) =>
        (i ? "L" : "M") + xf(p.gameTime).toFixed(1) + " " + yf(p.signedGold).toFixed(1)
      ).join(" ")

      let out = ""
      out += '<line x1="' + padL + '" y1="' + mid.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + mid.toFixed(1) + '" stroke="rgba(255,255,255,.2)" stroke-width="1"/>'

      for (const s of segs) {
        if (s.pts.length < 2) continue
        const d = mkD(s.pts)
        const x0 = xf(s.pts[0].gameTime).toFixed(1)
        const xN = xf(s.pts[s.pts.length - 1].gameTime).toFixed(1)
        const fill = s.pos ? "rgba(100,168,255,.15)" : "rgba(255,107,107,.15)"
        out += '<path fill="' + fill + '" stroke="none" d="' + d + ' L' + xN + ' ' + mid.toFixed(1) + ' L' + x0 + ' ' + mid.toFixed(1) + ' Z"/>'
      }
      for (const s of segs) {
        if (s.pts.length < 2) continue
        const stroke = s.pos ? "#64a8ff" : "#ff6b6b"
        out += '<path fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="' + mkD(s.pts) + '"/>'
      }

      const last = clean[clean.length - 1]
      const lx = xf(last.gameTime).toFixed(1), ly = yf(Number(last.signedGold)).toFixed(1)
      const dc = Number(last.signedGold) >= 0 ? "#64a8ff" : "#ff6b6b"
      out += '<circle cx="' + lx + '" cy="' + ly + '" r="5" fill="' + dc + '" opacity=".18"/>'
      out += '<circle cx="' + lx + '" cy="' + ly + '" r="2.5" fill="' + dc + '"/>'

      const lbl = (y, txt) => '<text text-anchor="end" x="' + (padL - 5) + '" y="' + y + '" dy=".35em" fill="rgba(255,255,255,.38)" font-size="10" font-family="Inter,sans-serif">' + txt + "</text>"
      out += lbl(padT + 2, "+" + fmtK(maxAbs))
      out += lbl(mid, "0")
      out += lbl(H - padB - 2, "-" + fmtK(maxAbs))

      el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + out + '</svg><div class="gc-indicator"></div>'

      _gcData = { clean, xf, W, padL, cW }

      // Create tooltip once
      if (!document.getElementById("gc-tip")) {
        const tip = document.createElement("div")
        tip.id = "gc-tip"
        tip.style.cssText = "position:fixed;display:none;pointer-events:none;z-index:999;background:#1a1e22;border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:5px 10px;font-size:12px;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.5);"
        document.body.appendChild(tip)
      }

      el.onmousemove = function(e) {
        if (!_gcData) return
        const { clean, xf, W, padL, cW } = _gcData
        const rect = el.getBoundingClientRect()
        const scrollLeft = el.scrollLeft || 0
        const svgPxW = Math.max(el.scrollWidth, rect.width)
        const svgX = ((e.clientX - rect.left + scrollLeft) / svgPxW) * W
        const ind = el.querySelector(".gc-indicator")
        const tip = document.getElementById("gc-tip")

        if (svgX < padL || svgX > padL + cW) {
          if (ind) ind.style.display = "none"
          if (tip) tip.style.display = "none"
          return
        }

        const minT = clean[0].gameTime, maxT = clean[clean.length - 1].gameTime
        const hoverT = minT + (svgX - padL) / cW * (maxT - minT)
        const pt = clean.reduce((a, b) =>
          Math.abs(Number(b.gameTime) - hoverT) < Math.abs(Number(a.gameTime) - hoverT) ? b : a
        )

        const g = Number(pt.signedGold)
        const color = g >= 0 ? "#64a8ff" : "#ff6b6b"
        const sign = g > 0 ? "+" : ""
        const gt = Number(pt.gameTime)
        const mm = Math.floor(gt / 60)
        const ss = String(Math.floor(gt % 60)).padStart(2, "0")

        if (ind) {
          ind.style.display = "block"
          ind.style.left = ((xf(Number(pt.gameTime)) / W) * svgPxW - scrollLeft).toFixed(1) + "px"
        }

        if (tip) {
          tip.style.display = "block"
          tip.style.left = (e.clientX + 14) + "px"
          tip.style.top = (e.clientY - 16) + "px"
          tip.innerHTML =
            '<span style="color:' + color + ';font-weight:700">' + sign + Math.round(g).toLocaleString("pt-BR") + 'g</span>' +
            ' <span style="color:rgba(255,255,255,.4);font-size:11px">' + mm + ":" + ss + "</span>"
        }
      }

      el.onmouseleave = function() {
        const ind = el.querySelector(".gc-indicator")
        if (ind) ind.style.display = "none"
        const tip = document.getElementById("gc-tip")
        if (tip) tip.style.display = "none"
      }
    }

    function mvpScore(p) {
      const k = Number(p.kills ?? 0), d = Number(p.deaths ?? 0), a = Number(p.assists ?? 0)
      const cs = Number(p.cs ?? 0), gold = Number(p.netWorth ?? 0)
      const kda = (k + a) / Math.max(1, d)
      return kda * 3 + k * 0.5 + a * 0.3 + cs * 0.01 + gold * 0.0002
    }

    function renderGameResult(gameEnd) {
      const el = $("game-result")
      if (!el) return
      if (!gameEnd) { el.style.display = "none"; el.innerHTML = ""; return }

      const d = gameEnd.data || gameEnd
      const allPlayers = d.allPlayers || []
      const duration = Number(d.gameTime || 0)
      const rawResult = String(d.result || "").toLowerCase()
      // result: "Win" = vitória, "Lose"/"Fail" = derrota, "" = desconhecido
      const isWin  = rawResult === "win"
      const isLose = rawResult === "lose" || rawResult === "fail"
      const resultClass = isWin ? "win" : isLose ? "lose" : "unknown"
      const resultLabel = isWin ? "VITÓRIA" : isLose ? "DERROTA" : "PARTIDA ENCERRADA"
      const resultColor = isWin ? "var(--green)" : isLose ? "var(--red)" : "var(--muted)"

      const myTeam = String(d.myTeam || "")
      const order = allPlayers.filter(p => p.team === "ORDER")
      const chaos = allPlayers.filter(p => p.team === "CHAOS")
      const myTeamPlayers  = myTeam === "CHAOS" ? chaos : myTeam === "ORDER" ? order : allPlayers
      const oppTeamPlayers = myTeam === "CHAOS" ? order : myTeam === "ORDER" ? chaos : []

      // MVP: melhor pontuação no time aliado (ou geral se time desconhecido)
      const pool = myTeamPlayers.length ? myTeamPlayers : allPlayers
      const sorted = [...pool].sort((a, b) => mvpScore(b) - mvpScore(a))
      const mvp = sorted[0]
      const worst = sorted[sorted.length - 1]

      function playerCard(p, type) {
        if (!p) return ""
        const k = Number(p.kills ?? 0), dea = Number(p.deaths ?? 0), a = Number(p.assists ?? 0)
        return '<div class="game-result-player-card ' + type + '">' +
          '<div class="game-result-player-label ' + type + '">' + (type === "mvp" ? "⭐ MVP" : "💀 Pior") + '</div>' +
          '<div class="game-result-player-name">' + esc(p.summonerName || "?") + '</div>' +
          '<div class="game-result-player-champ">' + esc(p.championName || "") + '</div>' +
          '<div class="game-result-player-kda">' + k + '/' + dea + '/' + a + '</div>' +
        '</div>'
      }

      function teamRows(players, label) {
        if (!players.length) return ""
        const header = '<div class="game-result-team-label">' + esc(label) + '</div>'
        const rows = players.map(p => {
          const k = Number(p.kills ?? 0), dea = Number(p.deaths ?? 0), a = Number(p.assists ?? 0)
          const cs = Number(p.cs ?? 0)
          const gold = Number(p.netWorth ?? 0)
          const meClass = p.isMe ? " me" : ""
          return '<div class="game-result-scoreboard-row' + meClass + '">' +
            '<span class="col-name">' + esc(p.summonerName || "?") + '</span>' +
            '<span class="col-champ">' + esc(p.championName || "") + '</span>' +
            '<span class="col-kda">' + k + '/' + dea + '/' + a + '</span>' +
            '<span class="col-cs">' + cs + '</span>' +
            (gold > 0 ? '<span class="col-gold">' + Math.round(gold / 1000) + 'k</span>' : '') +
          '</div>'
        }).join("")
        return header + rows
      }

      const mvpRow = sorted.length >= 2
        ? '<div class="game-result-mvp-row">' + playerCard(mvp, "mvp") + playerCard(worst, "worst") + '</div>'
        : (mvp ? '<div class="game-result-mvp-row">' + playerCard(mvp, "mvp") + '</div>' : "")

      const scoreboardHtml = (order.length || chaos.length)
        ? '<div class="game-result-scoreboard">' +
            teamRows(myTeam === "CHAOS" ? chaos : order, myTeam === "CHAOS" ? "Caos (Aliados)" : "Order (Aliados)") +
            teamRows(myTeam === "CHAOS" ? order : chaos, myTeam === "CHAOS" ? "Order (Inimigos)" : "Caos (Inimigos)") +
          '</div>'
        : ""

      el.style.display = ""
      el.innerHTML =
        '<div class="game-result-banner ' + resultClass + '">' +
          '<div class="game-result-title" style="color:' + resultColor + '">' + resultLabel + '</div>' +
          (duration > 0 ? '<div class="game-result-duration">' + fmt(duration) + '</div>' : '') +
          mvpRow +
          scoreboardHtml +
        '</div>'
    }

    function renderPostGameAnalysis(post) {
      const status = post?.status || "aguardando"
      $("post-game-status").textContent = status
      $("post-game-status").className = "pill " + (status === "pronto" ? "green" : status === "erro" ? "red" : status === "gerando" ? "yellow" : "")

      if (!post) {
        $("post-game-analysis").innerHTML = '<div class="empty">Aguardando fim da partida</div>'
        return
      }
      if (status === "gerando") {
        $("post-game-analysis").innerHTML = '<div class="empty">Gerando analise com Gemini...</div>'
        return
      }
      if (status === "erro") {
        $("post-game-analysis").innerHTML = '<div class="alert red"><div class="alert-title">Falha na analise</div><div class="sub">' + esc(post.error || "erro desconhecido") + '</div></div>'
        return
      }
      if (status === "ignorado") {
        $("post-game-analysis").innerHTML = '<div class="alert yellow"><div class="alert-title">Analise ignorada</div><div class="sub">' + esc(post.detail || "Partida curta/remake") + '</div></div>'
        return
      }

      const a = post.analysis || {}
      const rawAi = a.rawText || post.rawText || JSON.stringify(a, null, 2)
      const rawTitle = a.rawText || post.rawText ? "Resposta da IA" : "Resposta da IA salva"
      const rawBlock = rawAi
        ? '<div class="sub" style="margin-top:12px;font-weight:800">' + rawTitle + '</div><pre class="raw-ai">' + esc(rawAi) + '</pre>'
        : '<div class="sub" style="margin-top:12px">Resposta da IA nao foi gravada para esta partida.</div>'
      $("post-game-analysis").innerHTML =
        '<div class="analysis-text"><strong>' + esc(a.resumo || "Analise pronta") + '</strong></div>' +
        '<div class="grid-2" style="margin-top:10px">' +
          '<div class="metric"><label>Campeao</label><strong>' + esc(post.championName || "-") + '</strong></div>' +
          '<div class="metric"><label>Nota</label><strong>' + esc(a.nota ?? "-") + '/10</strong></div>' +
        '</div>' +
        '<div class="sub" style="margin-top:12px;font-weight:800">Foi bem</div>' +
        '<ul class="analysis-list">' + (a.foi_bem || []).map(x => '<li>' + esc(x) + '</li>').join("") + '</ul>' +
        '<div class="sub" style="margin-top:12px;font-weight:800">Errou em</div>' +
        '<ul class="analysis-list">' + (a.errou || []).map(x => '<li>' + esc(x) + '</li>').join("") + '</ul>' +
        '<div class="alert blue" style="margin-top:12px"><div class="alert-title">Dica pro proximo</div><div class="sub">' + esc(a.dica || "-") + '</div></div>' +
        rawBlock
    }

    function renderSidePanels(champSelect, loading, scoreboard) {
      const allyChamp = champSelect?.myTeam || []
      const enemyChamp = champSelect?.enemyTeam || []
      const allyAnalysis = loading?.myTeam || []
      const enemyAnalysis = loading?.enemyTeam || []
      const players = scoreboard?.players || []
      const me = players.find(p => p.isMe)
      const allyLive = me?.team ? players.filter(p => p.team === me.team) : []
      const enemyLive = me?.team ? players.filter(p => p.team && p.team !== me.team) : []
      const highGold = topBy([...allyLive, ...enemyLive], "netWorth")

      $("ally-phase").textContent = champSelect?.phase || "-"
      $("enemy-phase").textContent = champSelect?.phase || "-"
      $("ally-count").textContent = Math.max(allyChamp.length, allyAnalysis.length, allyLive.length)
      $("enemy-count").textContent = Math.max(enemyChamp.length, enemyAnalysis.length, enemyLive.length)

      $("ally-team").innerHTML = renderTeamCards("ALLY", allyChamp, allyAnalysis, allyLive, enemyChamp, enemyAnalysis, enemyLive, highGold)
      $("enemy-team").innerHTML = renderTeamCards("ENEMY", enemyChamp, enemyAnalysis, enemyLive, allyChamp, allyAnalysis, allyLive, highGold)
      $("ally-bans").innerHTML = renderBans(champSelect?.bans?.myTeam || loading?.bans?.myTeam || [])
      $("enemy-bans").innerHTML = renderBans(champSelect?.bans?.enemyTeam || loading?.bans?.enemyTeam || [])

      const a = loading?.analysis || {}
      const myMMR    = a.myTeamAvgMmr    || 0
      const enemyMMR = a.enemyTeamAvgMmr || 0
      const myElo    = myMMR    ? mmrToEloLabel(myMMR)    : null
      const enemyElo = enemyMMR ? mmrToEloLabel(enemyMMR) : null

      $("ally-elo").textContent  = myElo    ? myElo    + " · " + myMMR    : "-"
      $("enemy-elo").textContent = enemyElo ? enemyElo + " · " + enemyMMR : "-"

      const mc = $("mmr-compare")
      if (myMMR && enemyMMR) {
        mc.style.display = ""
        const diff = enemyMMR - myMMR
        const diffStr  = diff !== 0 ? (diff > 0 ? "+" + diff : String(diff)) + " MMR" : "="
        const diffColor = diff > 0 ? "var(--red)" : diff < 0 ? "var(--green)" : "var(--muted)"
        mc.innerHTML =
          '<div class="mmr-compare-team">' +
            '<div class="mmr-compare-tier" style="color:var(--blue)">' + esc(myElo) + '</div>' +
            '<div class="mmr-compare-mmr">Aliados · ' + myMMR + ' MMR</div>' +
          '</div>' +
          '<div class="mmr-compare-center">' +
            '<div class="mmr-compare-vs">VS</div>' +
            '<div class="mmr-compare-diff" style="color:' + diffColor + '">' + esc(diffStr) + '</div>' +
          '</div>' +
          '<div class="mmr-compare-team right">' +
            '<div class="mmr-compare-tier" style="color:var(--red)">' + esc(enemyElo) + '</div>' +
            '<div class="mmr-compare-mmr">Inimigos · ' + enemyMMR + ' MMR</div>' +
          '</div>'
      } else {
        mc.style.display = "none"
      }
      $("ally-analysis").innerHTML = renderAnalysisPanel(allyAnalysis, [a.highestEloMyTeam, a.lowestEloMyTeam], allyChamp, allyLive, a, "ALLY")
      $("enemy-analysis").innerHTML = renderAnalysisPanel(enemyAnalysis, [a.highestEloEnemyTeam, a.lowestEloEnemyTeam], enemyChamp, enemyLive, a, "ENEMY")
    }

    function renderTeamCards(side, champTeam, analysisTeam, liveTeam, opponentChampTeam, opponentAnalysisTeam, opponentLiveTeam, highGold) {
      const entries = buildTeamEntries(champTeam, analysisTeam, liveTeam)
      const opponents = buildTeamEntries(opponentChampTeam, opponentAnalysisTeam, opponentLiveTeam)
      if (!entries.length) return '<div class="empty">Aguardando champ select</div>'
      const rows = []
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const c = entry.champ
        const a = entry.analysis
        const l = entry.live
        const opponent = opponentForEntry(entry, opponents, i)
        const oppLive = opponent?.live || {}
        const oppAnalysis = opponent?.analysis || {}
        const pick = entry.championName || (a.championId ? "Campeao pendente" : "-")
        const intent = c.pickIntentName || (c.pickIntentId ? "ID " + c.pickIntentId : "")
        const highGoldClass = isSameLivePlayer(l, highGold) ? " high-gold" : ""
        const youBadge = entry.isMe ? ' <span style="color:var(--yellow);font-size:11px;font-weight:700">(você)</span>' : ''
        rows.push(
          '<div class="champ-card' + highGoldClass + '"><div class="champ-main"><div><div class="champ-name">' + esc(pick) + youBadge + '</div><div class="sub">' + esc(entry.summonerName) + (intent ? ' · intencao ' + esc(intent) : '') + '</div></div><span class="pill ' + (side === "ALLY" ? "blue" : "red") + '">' + esc(entry.roleLabel) + '</span></div>' +
          '<div class="champ-meta">' +
          renderMetricDiff("Elo", a.mmr, oppAnalysis.mmr, 0, "", a.elo?.label) +
          renderMetricDiff("Gold", l?.netWorth, oppLive.netWorth, 0, "g") +
          renderMetricDiff("Kills", l?.kills, oppLive.kills, 0) +
          renderMetricDiff("Lv", l?.level, oppLive.level, 0) +
          renderMetricDiff("CS", l?.cs, oppLive.cs, 0) +
          renderKdaLine(l, oppLive) +
          (!l || !Object.keys(l).length ? '<span class="pill yellow">aguardando live</span>' : '') +
          '</div></div>'
        )
      }
      return rows.join("")
    }

    function buildTeamEntries(champTeam, analysisTeam, liveTeam) {
      const entries = []
      const usedChamp = new Set()
      const usedLive = new Set()
      const usedAnalysis = new Set()

      for (let i = 0; i < analysisTeam.length; i++) {
        const a = analysisTeam[i] || {}
        const c = matchChampForAnalysis(a, champTeam, i) || {}
        const l = matchLive(c, a, liveTeam, i) || {}
        if (c.championId) usedChamp.add(Number(c.championId))
        if (l.summonerName || l.championName) usedLive.add(l.summonerName || l.championName)
        usedAnalysis.add(i)
        entries.push(teamEntry(c, a, l, i))
      }

      for (let i = 0; i < champTeam.length; i++) {
        const c = champTeam[i] || {}
        if (c.championId && usedChamp.has(Number(c.championId))) continue
        const aIndex = analysisTeam.findIndex(a => a?.championId && Number(a.championId) === Number(c.championId))
        const a = aIndex >= 0 ? analysisTeam[aIndex] : {}
        const l = matchLive(c, a, liveTeam, i) || {}
        if (aIndex >= 0) usedAnalysis.add(aIndex)
        if (l.summonerName || l.championName) usedLive.add(l.summonerName || l.championName)
        entries.push(teamEntry(c, a, l, i))
      }

      for (let i = 0; i < liveTeam.length; i++) {
        const l = liveTeam[i] || {}
        const liveKey = l.summonerName || l.championName
        if (liveKey && usedLive.has(liveKey)) continue
        const c = champTeam.find(ch => ch.championName && ch.championName === l.championName) || {}
        const a = analysisTeam.find(an => an.championId && c.championId && Number(an.championId) === Number(c.championId)) ||
          analysisTeam.find(an => an.championName && an.championName === l.championName) || {}
        entries.push(teamEntry(c, a, l, i))
      }

      return entries.sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.originalIndex - b.originalIndex)
    }

    function teamEntry(c, a, l, index) {
        const championName = c.championName || l?.championName || a.championName || ""
        const role = normalizeRole(a.assignedPosition || c.position || roleFromIndex(index))
        return {
          champ: c,
          analysis: a,
          live: l || {},
          role,
          roleLabel: roleLabel(role),
          championName,
          summonerName: bestSummonerName(a.summonerName, l?.summonerName, championName, a.puuid || c.puuid),
          originalIndex: index,
          isMe: !!(l?.isMe || c?.isMe || a?.isMe),
        }
    }

    function opponentForEntry(entry, opponents, index) {
      return opponents.find(o => o.role === entry.role) || opponents[index] || null
    }

    function isSameLivePlayer(player, target) {
      if (!player || !target) return false
      if (player.summonerName && target.summonerName && player.summonerName === target.summonerName) return true
      return player.championName && target.championName &&
        player.championName === target.championName &&
        player.team === target.team
    }

    function normalizeRole(pos) {
      const p = String(pos || "").toUpperCase()
      if (p === "TOP") return "TOP"
      if (p === "JUNGLE") return "JUNGLE"
      if (p === "MID" || p === "MIDDLE") return "MID"
      if (p === "BOT" || p === "BOTTOM" || p === "ADC") return "ADC"
      if (p === "SUPPORT" || p === "UTILITY") return "SUPPORT"
      return ""
    }

    function roleFromIndex(index) {
      return ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"][index] || ""
    }

    function roleOrder(role) {
      return { TOP: 0, JUNGLE: 1, MID: 2, ADC: 3, SUPPORT: 4 }[role] ?? 99
    }

    function roleLabel(role) {
      return role === "ADC" ? "ADC" : role === "SUPPORT" ? "SUP" : role || "-"
    }

    function renderMetricDiff(label, own, opp, decimals = 0, suffix = "", context = "") {
      if (own === null || own === undefined || opp === null || opp === undefined) return ""
      const a = Number(own)
      const b = Number(opp)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return ""
      const diff = a - b
      if (diff === 0) return '<span class="pill">' + esc(equalMetricLabel(label, context)) + '</span>'
      const cls = diff > 0 ? " green" : diff < 0 ? " red" : ""
      const sign = diff > 0 ? "+" : ""
      const formatted = decimals > 0 ? diff.toFixed(decimals) : diff.toLocaleString("pt-BR")
      const detail = context ? " · " + context : ""
      return '<span class="pill' + cls + '">' + esc(label + " " + sign + formatted + suffix + detail) + '</span>'
    }

    function equalMetricLabel(label, context = "") {
      const detail = context ? " · " + context : ""
      if (label === "Elo") return "Elos iguais" + detail
      if (label === "Lv") return "Mesmo nivel"
      if (label === "Gold") return "Gold igual"
      if (label === "Kills") return "Kills iguais"
      if (label === "CS") return "CS igual"
      if (label === "KDA") return "KDA igual"
      return label + " igual"
    }

    function renderKdaLine(player, opponent) {
      if (!player || !Number.isFinite(Number(player.kills))) return ""
      const diff = kdaScore(player) - kdaScore(opponent)
      const cls = diff > 0 ? " green" : diff < 0 ? " red" : ""
      return '<span class="pill' + cls + '">' + esc("KDA " + Number(player.kills ?? 0) + "/" + Number(player.deaths ?? 0) + "/" + Number(player.assists ?? 0)) + '</span>'
    }

    function kdaScore(player) {
      if (!player || !Number.isFinite(Number(player.kills))) return null
      const deaths = Math.max(1, Number(player.deaths ?? 0))
      return (Number(player.kills ?? 0) + Number(player.assists ?? 0)) / deaths
    }
    function matchLive(champ, analysis, liveTeam, index) {
      if (analysis?.summonerName) {
        const byName = liveTeam.find(p => p.summonerName === analysis.summonerName)
        if (byName) return byName
      }
      if (champ?.championName) {
        const byChamp = liveTeam.find(p => p.championName === champ.championName)
        if (byChamp) return byChamp
      }
      return liveTeam[index]
    }

    function renderBans(list) {
      return list.length ? list.map(b => '<span class="ban">' + esc(b) + '</span>').join("") : '<div class="empty">Sem bans ainda</div>'
    }

    function renderAnalysisPanel(team, extremes, champTeam, liveTeam, analysis, side) {
      if (!team.length && !extremes.filter(Boolean).length)
        return '<div class="empty">Aguardando loading analysis</div>'

      const cards = []

      for (let i = 0; i < team.length; i++) {
        const p = enrichAnalysisPlayer(team[i], champTeam, liveTeam, i)
        const flags = sanitizedSmurfFlags(p)
        const hasRisk = flags.length > 0 || p.newChampion

        const eloTxt = p.elo?.label || "Unranked"
        const mmrTxt = p.mmr ? "~" + p.mmr : ""
        const lvTxt  = validAccountLevel(p.level) ? "Lv " + p.level : ""
        const wrTxt  = p.elo?.totalGames > 0
          ? (p.elo?.reliableWinRate ? p.elo.winRate + "%WR/" + p.elo.totalGames + "j" : "WR ind.")
          : ""
        const detail = [eloTxt, mmrTxt, lvTxt, wrTxt].filter(Boolean).join(" · ")

        // Header: champion name prominent, player name below
        const champName = p.championName || ""
        const champHtml = champName
          ? '<span class="ap-champ">' + esc(champName) + '</span>'
          : '<span class="ap-name">' + esc(p.summonerName || "-") + '</span>'
        const subNameHtml = champName
          ? '<div class="ap-sub-name">' + esc(p.summonerName || "-") + (p.isMe ? ' <span style="color:var(--yellow);font-weight:700">(você)</span>' : "") + '</div>'
          : (p.isMe ? '<div class="ap-sub-name" style="color:var(--yellow);font-weight:700">(você)</div>' : "")

        // Pills
        const streakData = p.streak
        const streakPill = streakData && streakData.count >= 2
          ? ' <span class="pill ' + (streakData.type === "win" ? "green" : "red") + '">' + streakData.count + (streakData.type === "win" ? "W" : "L") + '</span>'
          : (p.hotStreak && !streakData ? ' <span class="pill green">streak W</span>' : "")
        const newChampPill  = p.newChampion ? ' <span class="pill yellow">novo champ</span>' : ""
        const autofillPill  = p.autofill
          ? ' <span class="pill orange">' + esc(p.selectedPosition || "?") + '→' + esc(p.assignedPosition || "?") + '</span>'
          : ""

        cards.push(
          '<div class="analysis-player' + (hasRisk ? " risk" : "") + '">' +
          '<div class="ap-head">' + champHtml + streakPill + newChampPill + autofillPill + '</div>' +
          subNameHtml +
          '<div class="sub">' + esc(detail) + '</div>' +
          (flags.length ? '<div class="risk-flags">' + esc(flags.map(f => f.label).join(" · ")) + '</div>' : '') +
          '</div>'
        )
      }

      if (!team.length) {
        for (const [i, p] of extremes.filter(Boolean).entries()) {
          if (!p) continue
          const player = enrichAnalysisPlayer(p, champTeam, liveTeam, i)
          cards.push(
            '<div class="analysis-player"><div class="ap-head"><span class="ap-name">' + esc(player.summonerName || "-") + '</span></div>' +
            '<div class="sub">' + esc((player.elo?.label || "-") + (player.mmr ? " · ~" + player.mmr : "")) + '</div></div>'
          )
        }
      }

      return cards.join("") || '<div class="empty">Aguardando loading analysis</div>'
    }
    function analysisLine(p) {
      const flags = sanitizedSmurfFlags(p).map(f => f.label).join(", ")
      const streak = p.streak?.type && p.streak.count >= 3 ? '<span class="pill ' + (p.streak.type === "win" ? "green" : "red") + '">' + p.streak.count + (p.streak.type === "win" ? "W" : "L") + '</span>' : ""
      const level = validAccountLevel(p.level) ? 'Lv ' + p.level : 'Lv ?'
      const wr = p.elo?.reliableWinRate ? ' · ' + p.elo.winRate + '% WR / ' + p.elo.totalGames + 'j' : ''
      const champ = p.championName ? ' · ' + p.championName : ''
      return '<div class="alert-title">' + esc(p.summonerName || "-") + '</div><div class="sub">' + esc(p.elo?.label || p.elo || "-") + champ + ' · ~' + esc(p.mmr || "-") + ' · ' + level + wr + '</div>' + streak + (flags ? '<div class="sub">' + esc(flags) + '</div>' : '')
    }

    function enrichAnalysisPlayer(player, champTeam, liveTeam, index) {
      const champ = matchChampForAnalysis(player, champTeam, index) || {}
      const live = matchLive(champ, player, liveTeam, index) || {}
      const championName = player?.championName || champ.championName || live.championName || ""
      const summonerName = bestSummonerName(player?.summonerName, live.summonerName, championName, player?.puuid)
      return {
        ...player,
        summonerName,
        championName,
        assignedPosition: player?.assignedPosition || champ.position || "",
        level: validAccountLevel(player?.level) ? Number(player.level) : null,
      }
    }

    function matchChampForAnalysis(player, champTeam, index) {
      if (player?.championId) {
        const byId = champTeam.find(p => Number(p.championId) === Number(player.championId))
        if (byId) return byId
      }
      if (player?.assignedPosition) {
        const byPos = champTeam.find(p => p.position === player.assignedPosition)
        if (byPos) return byPos
      }
      return champTeam[index]
    }

    function bestSummonerName(primary, liveName, championName, puuid) {
      for (const name of [primary, liveName]) {
        if (!name) continue
        const s = String(name)
        if (puuid && s === String(puuid).slice(0, 8)) continue
        if (championName && s.toLowerCase() === String(championName).toLowerCase()) continue
        if (isLikelyPuuidHash(s)) continue
        return s
      }
      return championName ? championName + " (nick oculto)" : "Jogador"
    }

    function isLikelyPuuidHash(name) {
      return /^[0-9a-f]{8}$/i.test(String(name || ""))
    }

    function validAccountLevel(level) {
      const n = Number(level)
      return Number.isFinite(n) && n > 0
    }

    function sanitizedSmurfFlags(player) {
      const flags = player?.smurfFlags || []
      if (validAccountLevel(player?.level)) return flags
      return flags.filter(f => !["very_low_level", "low_level_high_elo"].includes(f.code))
    }
    const START_MSGS = [
      "Começa o jogo na Vila Belmiro!",
      "Começou!! Bora dar aquela pressão",
      "Partida iniciada — foco total",
      "Boa sorte e bom jogo!",
      "GLHF! Que vença o melhor time",
      "Jogo em andamento — domina o mapa",
    ]
    const END_MSGS = [
      "Partida encerrada — GG!",
      "Fim de jogo! Análise pós-jogo a caminho...",
      "GG WP! Aguardando análise...",
      "Jogo finalizado!",
      "Boa partida! Até a próxima",
    ]

    function renderAlerts(s) {
      const phase = s.latestGameflow?.phase || s.presence?.phase || ""
      const gameTime = Number(s.latestGameUpdate?.gameTime ?? 0)
      const sessionKey = String(s.latestScoreboard?.gameId || s.latestGameUpdate?.gameId || Math.floor(gameTime / 60))

      const endPhases = ["EndOfGame", "WaitingForStats", "PreEndOfGame"]
      if (endPhases.some(p => phase.toLowerCase().includes(p.toLowerCase()))) {
        $("alert-count").textContent = "!"
        $("alerts").innerHTML = '<div class="alert-banner end">' + esc(pickStable(END_MSGS, "end" + sessionKey)) + '</div>'
        return
      }

      const alerts = gameAlerts(s.latestLoading, s.latestScoreboard, s.latestScoreboardAt, s.latestGameUpdate, s.events || [])
      const unique = dedupeAlerts(alerts).slice(0, 24)
      $("alert-count").textContent = String(unique.length)

      const startBanner = phase === "InProgress" && gameTime > 0 && gameTime < 60
        ? '<div class="alert-banner">' + esc(pickStable(START_MSGS, "start" + sessionKey)) + '</div>'
        : ""
      const alertsHtml = unique.map(a => {
        const champHtml = a.champion ? '<div class="alert-champ">' + esc(a.champion) + '</div>' : ''
        const nameHtml  = a.player  ? '<div class="alert-name">'  + esc(String(a.player).split('#')[0]) + '</div>' : ''
        const detHtml   = a.detail  ? '<div class="sub">'         + esc(a.detail) + '</div>' : ''
        return '<div class="alert ' + esc(a.kind || "") + '">' + champHtml + nameHtml + '<div class="alert-msg">' + esc(a.title) + '</div>' + detHtml + '</div>'
      }).join("") || (phase === "InProgress" ? '<div class="empty">Sem alertas agora</div>' : '<div class="empty">Aguardando partida</div>')

      $("alerts").innerHTML = startBanner + alertsHtml
    }

    function dedupeAlerts(alerts) {
      const seen = new Set()
      return alerts.filter(a => {
        const key = (a.kind || "") + "|" + a.title + "|" + a.detail
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    function loadingAlerts(loading, champSelect, scoreboard) {
      if (!loading) return []
      const out = []
      const analysis = loading.analysis || {}
      for (const s of analysis.streakAlerts || []) {
        const player = enrichAlertPlayer(s, loading, champSelect, scoreboard)
        const isMe = !!(player.isMe && s.team === "ALLY")
        const name = meOrName(isMe, player.summonerName)
        const key = (s.team || "") + s.count + s.type + (player.summonerName || "")
        const winTitles = isMe
          ? ["Você em sequência: " + s.count + " vitórias", "Você tá quente (" + s.count + "W)", "Você em " + s.count + " wins seguidas"]
          : [name + " em sequência: " + s.count + " vitórias", name + " tá quente (" + s.count + "W)", name + " em " + s.count + " wins seguidas"]
        const lossTitles = isMe
          ? ["Você em " + s.count + " derrotas — foco", "Você pode estar tilted (" + s.count + "L)", s.count + " losses seguidas: mentalize"]
          : [name + " em " + s.count + " derrotas seguidas", name + " pode estar tilted (" + s.count + "L)", s.count + " losses: " + name]
        out.push({
          kind: s.team === "ALLY" ? "blue" : "red",
          title: pickStable(s.type === "win" ? winTitles : lossTitles, key),
          detail: (s.team === "ALLY" ? "Aliado" : "Inimigo") + " - ultimas: " + (s.recent || []).join(""),
        })
      }
      for (const s of analysis.smurfSuspects || []) {
        const player = enrichAlertPlayer(s, loading, champSelect, scoreboard)
        const flags = sanitizedSmurfFlags(player)
        if (!flags.length) continue
        const isMe = !!(player.isMe && s.team === "ALLY")
        const name = meOrName(isMe, player.summonerName)
        const key = "smurf" + (s.team || "") + (player.summonerName || "")
        const titles = isMe
          ? ["Seu histórico é suspeito", "Flags de smurf: você"]
          : ["Possível smurf: " + name, name + " parece smurf", "Smurf alert: " + name]
        out.push({
          kind: s.team === "ALLY" ? "blue" : "red",
          title: pickStable(titles, key),
          detail: (s.team === "ALLY" ? "Aliado" : "Inimigo") + (validAccountLevel(player.level) ? " · Lv " + player.level : "") + " · ~" + player.mmr + " MMR · " + flags.map(f => f.label).join(", "),
        })
      }
      for (const p of [...(loading.myTeam || []), ...(loading.enemyTeam || [])]) {
        const total = Number(p.elo?.totalGames ?? 0)
        const wr = Number(p.elo?.winRate ?? 0)
        const reliable = p.elo?.reliableWinRate !== false
        const team = (loading.myTeam || []).includes(p) ? "ALLY" : "ENEMY"
        if (reliable && total >= 10 && total < 120 && wr >= 62 && wr <= 100) {
          const player = enrichAlertPlayer({ ...p, team }, loading, champSelect, scoreboard)
          const isMe = !!(player.isMe && team === "ALLY")
          const name = meOrName(isMe, player.summonerName)
          const key = "wr" + (team || "") + (player.summonerName || "") + Math.floor(wr)
          const titles = isMe
            ? ["Você tá quente: " + wr + "%WR", "Win rate alto — você · " + wr + "% em " + total + "j"]
            : ["Win rate alto: " + name, name + " tá quente: " + wr + "%WR", name + " · " + wr + "% em " + total + "j"]
          out.push({
            kind: team === "ALLY" ? "blue" : "red",
            title: pickStable(titles, key),
            detail: (isMe ? "Você" : (team === "ALLY" ? "Aliado" : "Inimigo")) + " · " + wr + "%WR em " + total + " jogos",
          })
        }
      }
      for (const a of analysis.autofillSuspects || []) {
        const player = enrichAlertPlayer(a, loading, champSelect, scoreboard)
        const isMe = !!(player.isMe && a.team === "ALLY")
        const name = meOrName(isMe, player.summonerName)
        const key = "auto" + (a.team || "") + (player.summonerName || "")
        const titles = isMe
          ? ["Você pode estar off-role", "Autofill possível — você"]
          : ["Autofill provável: " + name, name + " pode estar off-role", "Off-role: " + name]
        out.push({
          kind: a.team === "ALLY" ? "blue" : "red",
          title: pickStable(titles, key),
          detail: (a.team === "ALLY" ? "Aliado" : "Inimigo") + " · " + (a.selectedPosition || a.assignedPosition) + " → " + a.assignedPosition,
        })
      }
      return out
    }

    function enrichAlertPlayer(raw, loading, champSelect, scoreboard) {
      const isEnemy = raw.team === "ENEMY"
      const team = isEnemy ? (loading?.enemyTeam || []) : (loading?.myTeam || [])
      const idx = team.findIndex(p =>
        (raw.summonerName && p.summonerName === raw.summonerName) ||
        (raw.puuid && p.puuid === raw.puuid) ||
        (raw.championId && p.championId && Number(p.championId) === Number(raw.championId))
      )
      const base = { ...(idx >= 0 ? team[idx] : {}), ...raw }
      const champTeam = isEnemy ? (champSelect?.enemyTeam || []) : (champSelect?.myTeam || [])
      const live = liveTeams(scoreboard)
      const liveTeam = isEnemy ? live.enemy : live.ally
      return enrichAnalysisPlayer(base, champTeam, liveTeam, idx >= 0 ? idx : 0)
    }

    function liveTeams(scoreboard) {
      const players = scoreboard?.players || []
      const me = players.find(p => p.isMe)
      if (!me?.team) return { ally: [], enemy: [] }
      return {
        ally: players.filter(p => p.team === me.team),
        enemy: players.filter(p => p.team && p.team !== me.team),
      }
    }
    function gameAlerts(loading, scoreboard, scoreboardAt, gameUpdate, events) {
      const players = scoreboard?.players || []
      const me = players.find(p => p.isMe)
      if (!me) return objectiveAlerts(gameUpdate, events, null)
      if (!scoreboardAt || !Number.isFinite(Number(scoreboard?.gameTime))) return objectiveAlerts(gameUpdate, events, null)
      const ally = players.filter(p => p.team === me.team)
      const enemy = players.filter(p => p.team && p.team !== me.team)
      const allyAnalysis = loading?.myTeam || []
      const enemyAnalysis = loading?.enemyTeam || []
      const livePlayers = gameUpdate?.allPlayers || []
      const liveMe = livePlayers.find(p => p.summonerName === me.summonerName) || me
      const liveAlly = liveMe?.team ? livePlayers.filter(p => p.team === liveMe.team) : []
      const liveEnemy = liveMe?.team ? livePlayers.filter(p => p.team && p.team !== liveMe.team) : []
      const context = { ally, enemy, liveAlly, liveEnemy, allyAnalysis, enemyAnalysis }
      const out = objectiveAlerts(gameUpdate, events, context)
      const gameTime = Number(scoreboard.gameTime)

      const teamGold = scoreboard.teamGold || {}
      if (Number.isFinite(Number(teamGold.difference)) && me.team && gameTime >= 30) {
        const signedGold = teamGold.leading === me.team ? Number(teamGold.difference) : -Number(teamGold.difference)
        if (signedGold >= 2000) {
          const key = "teamgold+" + Math.floor(signedGold / 500)
          out.push({ kind: "blue", title: pickStable([
            "Seu time +" + signedGold.toLocaleString("pt-BR") + "g — pressiona",
            "Vantagem de " + signedGold.toLocaleString("pt-BR") + "g — hora dos objetivos",
            "+" + signedGold.toLocaleString("pt-BR") + "g · aproveita a janela",
          ], key), detail: "Snapshot " + fmt(gameTime) })
        }
        if (signedGold <= -2000) {
          const abs = Math.abs(signedGold)
          const key = "teamgold-" + Math.floor(abs / 500)
          out.push({ kind: "blue", title: pickStable([
            "Seu time -" + abs.toLocaleString("pt-BR") + "g — joga seguro",
            "Desvantagem de " + abs.toLocaleString("pt-BR") + "g — evita fights",
            "-" + abs.toLocaleString("pt-BR") + "g · recua e farma",
          ], key), detail: "Snapshot " + fmt(gameTime) })
        }
      }

      const allyCarry = topBy(ally, "netWorth")
      if (allyCarry && Number(allyCarry.netWorth) >= 12000) {
        const isMe = !!(allyCarry.isMe)
        const key = "carry" + (allyCarry.summonerName || allyCarry.championName || "")
        const titles = isMe
          ? ["Você tá farto — hora de fechar", "Você com maior gold — vai jogar", "Você dominando — hora de objetivos"]
          : ["Está farto — joga em torno", "Carry sólido — protege", "Com maior gold — joga em torno"]
        out.push({ kind: "blue", champion: allyCarry.championName, player: allyCarry.summonerName, title: pickStable(titles, key), detail: Number(allyCarry.netWorth).toLocaleString("pt-BR") + "g net worth" })
      }

      const enemyThreat = enemy.find(p => Number(p.kills ?? 0) >= 5 && Number(p.deaths ?? 0) <= 1)
      if (enemyThreat) {
        const key = "threat" + (enemyThreat.summonerName || enemyThreat.championName || "")
        out.push({ kind: "red", champion: enemyThreat.championName, player: enemyThreat.summonerName, title: pickStable([
          "Intocável — não enfrenta",
          "Está fed — evita confronto",
          "Atenção: tá fed",
          "Evita confronto direto",
        ], key), detail: "KDA " + enemyThreat.kills + "/" + enemyThreat.deaths + "/" + enemyThreat.assists })
      }

      for (const a of ally) {
        if (gameTime <= 360 && Number(a.deaths ?? 0) >= 2) {
          const isMe = !!(a.isMe)
          const key = "earlydeath" + (a.summonerName || a.championName || "")
          const titles = isMe
            ? ["Você já morreu " + a.deaths + "x — recua por ora", "Você tá morrendo cedo (" + a.deaths + "x)"]
            : ["Morreu " + a.deaths + "x antes dos 6min", "Early difícil (" + a.deaths + " mortes)", "Sofrendo cedo — " + a.deaths + "x"]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "early game em risco" })
        }
      }

      for (let i = 0; i < ally.length; i++) {
        const a = ally[i]
        const aInfo = findAnalysisForLive(a, allyAnalysis, i)
        const enemyMatch = findEnemyMatch(aInfo, enemy, enemyAnalysis, i)
        if (!isComparablePair(a, enemyMatch)) continue
        const isMe = !!(a.isMe)
        const name = meOrName(isMe, a.summonerName)

        const goldDiff = Number(enemyMatch.netWorth) - Number(a.netWorth)
        if (goldDiff >= 2000) {
          const key = "gold-" + (a.summonerName || "") + Math.floor(goldDiff / 500)
          const titles = isMe
            ? ["Você " + goldDiff.toLocaleString("pt-BR") + "g atrás — joga seguro", "Gap de " + goldDiff.toLocaleString("pt-BR") + "g — recua"]
            : [goldDiff.toLocaleString("pt-BR") + "g atrás do matchup", "Perde " + goldDiff.toLocaleString("pt-BR") + "g de gold", "Desvantagem de " + goldDiff.toLocaleString("pt-BR") + "g"]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "vs " + enemyMatch.championName + " · " + fmt(scoreboard.gameTime) })
        }
        const levelDiff = Number(enemyMatch.level) - Number(a.level)
        if (levelDiff >= 2) {
          const key = "level-" + (a.summonerName || "") + levelDiff
          const titles = isMe
            ? ["Você " + levelDiff + " níveis atrás — cuidado no fight", "XP em queda: Lv" + a.level + " vs Lv" + enemyMatch.level]
            : [levelDiff + " níveis atrás no matchup", "XP em queda: Lv" + a.level + " vs Lv" + enemyMatch.level]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "Lv " + a.level + " vs " + enemyMatch.championName + " Lv" + enemyMatch.level })
        }
        const csDiff = Number(enemyMatch.cs) - Number(a.cs)
        if (csDiff >= 50) {
          const key = "cs-" + (a.summonerName || "") + Math.floor(csDiff / 10)
          const titles = isMe
            ? ["Você " + csDiff + " CS atrás — melhora o farm", "Farm ruim: -" + csDiff + " CS"]
            : [csDiff + " CS atrás do matchup", "Farm ruim: -" + csDiff + " CS", csDiff + " CS atrás"]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "vs " + enemyMatch.championName + " · " + fmt(scoreboard.gameTime) })
        }
        if (gameTime >= 600 && gameTime <= 780 && isBotLane(aInfo) && csDiff >= 30) {
          const key = "botcs" + Math.floor(csDiff / 10)
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable([
            csDiff + " CS atrás aos 10min",
            "Farm da bot em queda: -" + csDiff + " CS",
            "Fase de farm perdida na bot: " + csDiff + " CS",
          ], key), detail: "vs " + enemyMatch.championName })
        }
        const itemDiff = itemCount(enemyMatch) - itemCount(a)
        if (itemDiff >= 2) {
          const key = "item-" + (a.summonerName || "") + itemDiff
          const titles = isMe
            ? ["Você atrás em itens completos", "Spike atrasado — " + enemyMatch.championName + " na frente"]
            : ["Atrás em itens completos", "Spike atrasado", enemyMatch.championName + " tem +" + itemDiff + " itens"]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "vs " + enemyMatch.championName + " +" + itemDiff + " itens · " + fmt(scoreboard.gameTime) })
        } else if (itemDiff <= -2) {
          const abs = Math.abs(itemDiff)
          const key = "itemadv-" + (a.summonerName || "") + abs
          const titles = isMe
            ? ["Você com spike de item — aproveita agora", "Você +" + abs + " itens completos — janela aberta"]
            : ["Com spike de item — aproveita a janela", "Vantagem de itens — aproveita", "+" + abs + " itens completos — janela aberta"]
          out.push({ kind: "blue", champion: a.championName, player: a.summonerName, title: pickStable(titles, key), detail: "+" + abs + " itens vs " + enemyMatch.championName })
        }
      }

      const allyJungle = findByPosition(ally, allyAnalysis, "JUNGLE")
      const enemyJungle = findByPosition(enemy, enemyAnalysis, "JUNGLE")
      if (isComparablePair(allyJungle, enemyJungle)) {
        const jgLevel = Number(enemyJungle.level) - Number(allyJungle.level)
        const jgCs = Number(enemyJungle.cs) - Number(allyJungle.cs)
        const isJgMe = !!(allyJungle?.isMe)
        if (jgLevel >= 2) {
          const key = "jglv" + jgLevel + (allyJungle.summonerName || "")
          const titles = isJgMe
            ? ["Você (jungle) " + jgLevel + " níveis atrás", "XP de jungle em queda: Lv" + allyJungle.level]
            : ["Jungle " + jgLevel + " níveis atrás", "Perdendo XP: -" + jgLevel + " níveis"]
          out.push({ kind: "blue", champion: allyJungle.championName, player: allyJungle.summonerName, title: pickStable(titles, key), detail: "vs " + (enemyJungle.championName || enemyJungle.summonerName) })
        }
        if (jgCs >= 20) {
          const key = "jgcs" + Math.floor(jgCs / 10) + (allyJungle.summonerName || "")
          const titles = isJgMe
            ? ["Você (jungle) " + jgCs + " CS atrás", "Farm de jungle em queda: -" + jgCs + " CS"]
            : ["Jungle " + jgCs + " CS atrás", "Farm da jungle ruim: -" + jgCs + " CS"]
          out.push({ kind: "blue", champion: allyJungle.championName, player: allyJungle.summonerName, title: pickStable(titles, key), detail: "vs " + (enemyJungle.championName || enemyJungle.summonerName) })
        }
      }

      return out
    }

    function objectiveAlerts(gameUpdate, events, context) {
      const gameTime = Number(gameUpdate?.gameTime ?? 0)
      if (!gameTime) return []
      const defs = [
        { type: "dragon", label: "Dragao", first: 300, respawn: 300 },
        { type: "baron", label: "Baron", first: 1200, respawn: 360 },
        { type: "herald", label: "Arauto", first: 840, respawn: 360 },
        { type: "void_grub", label: "Voidgrubs", first: 360, respawn: 240 },
      ]
      const out = []
      for (const def of defs) {
        const kills = events
          .filter(e => e.event_type === "objective" && e.data?.type === def.type)
          .map(e => Number(e.data?.eventTime ?? 0))
          .filter(Boolean)
          .sort((a, b) => b - a)
        const next = kills.length ? kills[0] + def.respawn : def.first
        const remaining = next - gameTime
        if (remaining > 0 && remaining <= 60) {
          out.push({ title: "1 min para " + def.label, detail: "Nasce em " + fmt(remaining) + " · tempo de jogo " + fmt(gameTime) })
        }
        if (remaining <= 0 && remaining >= -45) {
          out.push({ title: def.label + " disponivel", detail: "Janela aberta ha " + fmt(Math.abs(remaining)) })
        }
        if (context && remaining <= 60 && remaining >= -30) {
          const deadEnemies = context.liveEnemy.filter(p => p.isDead).length
          const deadAllies = context.liveAlly.filter(p => p.isDead).length
          if (deadEnemies >= 3) out.push({ kind: "red", title: "Janela de " + def.label, detail: deadEnemies + " inimigos mortos perto do objetivo" })
          else if (deadEnemies >= 2) out.push({ kind: "red", title: "Possivel janela de " + def.label, detail: deadEnemies + " inimigos mortos perto do objetivo" })
          if (deadAllies >= 3) out.push({ kind: "blue", title: "Evitar luta por " + def.label, detail: deadAllies + " aliados mortos perto do objetivo" })
          const allyJg = findByPosition(context.liveAlly, context.allyAnalysis, "JUNGLE")
          const enemyJg = findByPosition(context.liveEnemy, context.enemyAnalysis, "JUNGLE")
          if (allyJg?.isDead) out.push({ kind: "blue", title: "Jungler aliado morto antes de " + def.label, detail: allyJg.summonerName + " sem pressao de smite" })
          if (enemyJg?.isDead) out.push({ kind: "red", title: "Jungler inimigo morto antes de " + def.label, detail: enemyJg.summonerName + " sem pressao de smite" })
        }
      }
      const dragons = events.filter(e => e.event_type === "objective" && e.data?.type === "dragon").length
      if (dragons >= 3) out.push({ title: "Checar soul point", detail: dragons + " dragoes registrados nesta partida" })
      const earlyTower = events.find(e => e.event_type === "objective" && e.data?.type === "tower" && Number(e.data?.eventTime ?? 9999) <= 840)
      if (earlyTower) out.push({ title: "Torre caiu antes de 14 min", detail: "Plates/rota podem ter aberto cedo" })
      return out
    }

    function findAnalysisForLive(live, analysisTeam, index) {
      return analysisTeam.find(p => p.summonerName === live.summonerName) ||
        analysisTeam.find(p => p.championName && p.championName === live.championName) ||
        analysisTeam[index] || {}
    }

    function findEnemyMatch(allyInfo, enemyLive, enemyAnalysis, index) {
      const pos = allyInfo?.assignedPosition
      if (pos) {
        const enemyInfo = enemyAnalysis.find(p => p.assignedPosition === pos)
        if (enemyInfo) {
          const byName = enemyLive.find(p => p.summonerName === enemyInfo.summonerName)
          if (byName) return byName
          const byChampion = enemyLive.find(p => p.championName && p.championName === enemyInfo.championName)
          if (byChampion) return byChampion
        }
      }
      return enemyLive[index]
    }

    function findByPosition(liveTeam, analysisTeam, pos) {
      const info = (analysisTeam || []).find(p => p.assignedPosition === pos)
      if (info?.summonerName) {
        const byName = liveTeam.find(p => p.summonerName === info.summonerName)
        if (byName) return byName
      }
      const index = (analysisTeam || []).findIndex(p => p.assignedPosition === pos)
      return index >= 0 ? liveTeam[index] : null
    }

    function isBotLane(info) {
      const pos = String(info?.assignedPosition || "").toUpperCase()
      return pos === "BOT" || pos === "BOTTOM" || pos === "SUPPORT" || pos === "UTILITY"
    }

    function topBy(players, key) {
      const valid = (players || []).filter(p => Number.isFinite(Number(p[key])))
      if (!valid.length) return null
      return valid.reduce((a, b) => Number(a[key]) >= Number(b[key]) ? a : b)
    }
    function pickStable(arr, key) {
      let h = 0
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
      return arr[Math.abs(h) % arr.length]
    }
    function meOrName(isMe, name) { return isMe ? "Você" : (name || "Aliado") }

    function itemCount(player) {
      const ignored = new Set([3340, 3363, 3364, 2055, 2003, 2031, 2138, 2139, 2140])
      return (player?.items || []).filter(i => !ignored.has(Number(i.id)) && Number(i.price || 0) >= 2000).length
    }

    function isComparablePair(ally, enemy) {
      if (!ally || !enemy) return false
      if (!ally.summonerName || !enemy.summonerName) return false
      if (!ally.championName || !enemy.championName) return false
      return ["netWorth", "level", "cs"].every(key =>
        Number.isFinite(Number(ally[key])) && Number.isFinite(Number(enemy[key]))
      )
    }

    function renderEvents(list) {
      $("event-count").textContent = list.length
      $("events").innerHTML = list.slice(0, 35).map(e => {
        const when = e.created_at ? new Date(e.created_at).toLocaleTimeString("pt-BR") : ""
        const detail = summarize(e.event_type, e.data || {})
        return '<div class="event"><div><span class="event-type">' + esc(e.event_type) + '</span> <span class="sub">' + esc(when) + '</span></div><div class="event-detail">' + esc(detail) + '</div></div>'
      }).join("") || '<div class="empty">Sem eventos ainda</div>'
    }

    function summarize(type, d) {
      if (type === "gameflow_phase") return (d.previousPhase || "?") + " -> " + (d.phase || "?")
      if (type === "game_update" || type === "game_start") return fmt(d.gameTime) + " Â· KDA " + (d.me?.kills ?? 0) + "/" + (d.me?.deaths ?? 0) + "/" + (d.me?.assists ?? 0)
      if (type === "game_end") return "Duracao " + fmt(d.gameTime)
      if (type === "post_game_analysis") {
        if (d.status === "pronto") return "Analise pronta: " + (d.analysis?.resumo || "")
        if (d.status === "ignorado") return "Analise ignorada: " + (d.detail || "partida curta/remake")
        return "Analise pos-jogo " + (d.status || "")
      }
      if (type === "kill") return (d.killer || "?") + " -> " + (d.victim || "?") + " @" + fmt(d.eventTime)
      if (type === "objective") return (d.type || "objective") + " Â· " + (d.killer || "")
      if (type === "champ_select_complete") return (d.myChampionName || "?") + " Â· " + (d.myPosition || "?")
      if (type === "loading_analysis") return "Analise do loading atualizada"
      return JSON.stringify(d).slice(0, 140)
    }
  </script>
</body>
</html>`
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    res.end(html())
    return
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, snapshot())
    return
  }

  if (req.method === "POST" && url.pathname === "/api/toggle-analysis") {
    analysisEnabled = !analysisEnabled
    broadcast()
    sendJson(res, 200, { analysisEnabled })
    console.log(`[watch-ui] Analise IA ${analysisEnabled ? "ativada" : "desativada"}`)
    return
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
    return
  }

  sendJson(res, 404, { error: "not_found" })
})

const presenceChan = supabase.channel("idv-agent-presence")
presenceChan
  .on("presence", { event: "sync" }, () => {
    const state = presenceChan.presenceState<PresenceState & { puuid: string }>()
    onlineUsers.clear()
    for (const presences of Object.values(state)) {
      const p = presences[presences.length - 1]
      if (p?.puuid) {
        onlineUsers.set(p.puuid, { puuid: p.puuid, gameName: p.gameName, tagLine: p.tagLine, phase: p.phase, since: p.since })
        playerState(p.puuid)
      }
    }
    broadcast()
  })
  .subscribe()

supabase
  .channel("live_game_events_ui")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "live_game_events" }, payload => {
    pushEvent(payload.new as EventRow, true)
  })
  .subscribe(status => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      console.error("[watch-ui] Supabase Realtime caiu:", status)
    }
  })

setInterval(() => broadcast(), 1_000)

await hydrateEvents()
await retryFailedPostGameAnalyses()

server.listen(PORT, () => {
  console.log(`[watch-ui] IDV Watch UI aberta em http://localhost:${PORT}`)
})

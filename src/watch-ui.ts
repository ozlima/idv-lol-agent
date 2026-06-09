import http from "http"
import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { generatePostGameAnalysis, type EndGameSnapshot } from "./post-game-analysis.js"

config()

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
  phase: string
  since: string
}

const MAX_EVENTS = 80

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const events: EventRow[] = []
const onlineUsers = new Map<string, PresenceState>()
let latestLoading: Record<string, unknown> | null = null
let latestChampSelect: Record<string, unknown> | null = null
let latestGameflow: Record<string, unknown> | null = null
let latestScoreboard: Record<string, unknown> | null = null
let latestScoreboardAt: string | null = null
let latestGameUpdate: Record<string, unknown> | null = null
let latestGameUpdateAt: string | null = null
let latestPostGameAnalysis: Record<string, unknown> | null = null
const pendingPostGameAnalyses = new Set<string>()

const clients = new Set<http.ServerResponse>()

function nowIso() {
  return new Date().toISOString()
}

function mins(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function pushEvent(row: EventRow, realtime = false) {
  if (row.event_type === "raw_lol_event") return
  const event = { ...row, created_at: row.created_at ?? nowIso() }
  events.unshift(event)
  events.splice(MAX_EVENTS)

  if (row.event_type === "champ_select_state" || row.event_type === "champ_select_complete") {
    latestChampSelect = row.data
  }

  if (row.event_type === "loading_analysis") {
    latestLoading = row.data
  } else if (row.event_type === "gameflow_phase") {
    latestGameflow = row.data
  } else if (row.event_type === "scoreboard") {
    latestScoreboard = row.data
    latestScoreboardAt = event.created_at
  } else if (row.event_type === "game_update" || row.event_type === "game_start") {
    latestGameUpdate = row.data
    latestGameUpdateAt = event.created_at
  } else if (row.event_type === "post_game_analysis") {
    latestPostGameAnalysis = row.data
  }

  broadcast()
  if (realtime && row.event_type === "game_end") void analyzeGameEnd(event)
}

async function hydrateEvents() {
  const { data, error } = await supabase
    .from("live_game_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(MAX_EVENTS)

  if (error) {
    console.warn("[watch-ui] Nao foi possivel carregar eventos recentes:", error.message)
    return
  }

  for (const row of (data ?? []).reverse()) pushEvent(row as EventRow)
}

function snapshot() {
  return {
    now: nowIso(),
    onlineUsers: [...onlineUsers.values()],
    latestLoading,
    latestChampSelect,
    latestGameflow,
    latestScoreboard,
    latestScoreboardAt,
    latestGameUpdate,
    latestGameUpdateAt,
    latestPostGameAnalysis,
    events,
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

function findMePlayer() {
  const scoreboardPlayers = asList(latestScoreboard?.players)
  const scoreboardMe = scoreboardPlayers.find(p => p.isMe)
  const updateMe = asRecord(latestGameUpdate?.me)
  const updatePlayers = asList(latestGameUpdate?.allPlayers)
  const byName = updateMe.summonerName ? updatePlayers.find(p => p.summonerName === updateMe.summonerName) : null
  return { ...updateMe, ...asRecord(byName), ...asRecord(scoreboardMe) }
}

function gameEndKey(row: EventRow) {
  const gameTime = num(row.data?.gameTime) ?? num(latestGameUpdate?.gameTime) ?? num(latestScoreboard?.gameTime) ?? 0
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

  await insertPostGameStatus(row, "gerando", { startedAt: nowIso() })

  try {
    const me = findMePlayer()
    const gameUpdate = latestGameUpdate ?? {}
    const endData = row.data ?? {}
    const snapshotData: EndGameSnapshot = {
      summonerName: String(me.summonerName || gameUpdate?.summonerName || ""),
      championName: String(me.championName || gameUpdate?.championName || ""),
      position: String(me.position || me.assignedPosition || ""),
      result: String(endData.result || gameUpdate?.result || ""),
      duration: num(endData.gameTime) ?? num(gameUpdate?.gameTime) ?? num(latestScoreboard?.gameTime) ?? undefined,
      me,
      score: asRecord(gameUpdate?.score),
      teamGold: asRecord(latestScoreboard?.teamGold),
      teamCS: asRecord(gameUpdate?.teamCS),
      loading: latestLoading,
      scoreboard: latestScoreboard,
      gameUpdate: latestGameUpdate,
      events: events
        .filter(e => e.puuid === row.puuid && e.event_type !== "post_game_analysis")
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
            <div class="grid-2">
              <div class="metric"><label>Placar</label><strong id="score">-</strong></div>
              <div class="metric"><label>CS Times</label><strong id="cs">-</strong></div>
              <div class="metric"><label>Gold Diff</label><strong id="gold">-</strong></div>
              <div class="metric"><label>Online</label><strong id="online">0</strong></div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Alertas</span><span id="alert-count" class="pill yellow">0</span></div>
          <div class="panel-body" id="alerts"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Analise Pos-Jogo</span><span id="post-game-status" class="pill">aguardando</span></div>
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
    const $ = (id) => document.getElementById(id)
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec || 0))
      return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0")
    }
    setInterval(() => { if (state) render(state) }, 1000)

    const es = new EventSource("/events")
    es.onopen = () => $("conn").textContent = "conectado"
    es.onerror = () => $("conn").textContent = "reconectando"
    es.onmessage = (ev) => {
      state = JSON.parse(ev.data)
      render(state)
    }

    function render(s) {
      $("clock").textContent = new Date().toLocaleTimeString("pt-BR")
      $("online").textContent = s.onlineUsers.length
      $("phase").textContent = s.latestGameflow?.phase || s.onlineUsers[0]?.phase || "-"

      const gu = s.latestGameUpdate || {}
      const score = gu.score || {}
      const cs = gu.teamCS || {}
      $("game-time").textContent = gu.gameTime ? fmt(gu.gameTime) : "-"
      $("score").textContent = Number.isFinite(score.order) ? score.order + " x " + score.chaos : "-"
      $("cs").textContent = Number.isFinite(cs.order) ? cs.order + " x " + cs.chaos : "-"

      const sb = s.latestScoreboard || {}
      const gold = sb.teamGold || {}
      const players = sb.players || []
      const me = players.find(p => p.isMe)
      const myTeam = me?.team
      const signedGold = Number.isFinite(gold.difference) && myTeam
        ? (gold.leading === myTeam ? gold.difference : -gold.difference)
        : null
      $("gold").textContent = signedGold !== null
        ? (signedGold > 0 ? "+" : "") + signedGold.toLocaleString("pt-BR")
        : "-"

      renderSidePanels(s.latestChampSelect, s.latestLoading, s.latestScoreboard)
      renderAlerts(s)
      renderPostGameAnalysis(s.latestPostGameAnalysis)
      renderEvents(s.events || [])
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

      const a = post.analysis || {}
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
        '<div class="alert blue" style="margin-top:12px"><div class="alert-title">Dica pro proximo</div><div class="sub">' + esc(a.dica || "-") + '</div></div>'
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

      $("ally-phase").textContent = champSelect?.phase || "-"
      $("enemy-phase").textContent = champSelect?.phase || "-"
      $("ally-count").textContent = Math.max(allyChamp.length, allyAnalysis.length, allyLive.length)
      $("enemy-count").textContent = Math.max(enemyChamp.length, enemyAnalysis.length, enemyLive.length)

      $("ally-team").innerHTML = renderTeamCards("ALLY", allyChamp, allyAnalysis, allyLive)
      $("enemy-team").innerHTML = renderTeamCards("ENEMY", enemyChamp, enemyAnalysis, enemyLive)
      $("ally-bans").innerHTML = renderBans(champSelect?.bans?.myTeam || loading?.bans?.myTeam || [])
      $("enemy-bans").innerHTML = renderBans(champSelect?.bans?.enemyTeam || loading?.bans?.enemyTeam || [])

      const a = loading?.analysis || {}
      $("ally-elo").textContent = a.myTeamAvgMmr ? "MMR " + a.myTeamAvgMmr : "-"
      $("enemy-elo").textContent = a.enemyTeamAvgMmr ? "MMR " + a.enemyTeamAvgMmr : "-"
      $("ally-analysis").innerHTML = renderAnalysisPanel(allyAnalysis, [a.highestEloMyTeam, a.lowestEloMyTeam])
      $("enemy-analysis").innerHTML = renderAnalysisPanel(enemyAnalysis, [a.highestEloEnemyTeam, a.lowestEloEnemyTeam])
    }

    function renderTeamCards(side, champTeam, analysisTeam, liveTeam) {
      const size = Math.max(champTeam.length, analysisTeam.length, liveTeam.length)
      if (!size) return '<div class="empty">Aguardando champ select</div>'
      const rows = []
      for (let i = 0; i < size; i++) {
        const c = champTeam[i] || {}
        const a = analysisTeam[i] || {}
        const l = matchLive(c, a, liveTeam, i)
        const pick = c.championName || l?.championName || (a.championId ? "ID " + a.championId : "-")
        const intent = c.pickIntentName || (c.pickIntentId ? "ID " + c.pickIntentId : "")
        const name = l?.summonerName || a.summonerName || (c.isMe ? "Voce" : "Jogador " + (i + 1))
        const pos = c.position || a.assignedPosition || "-"
        const kda = l ? (l.kills ?? 0) + "/" + (l.deaths ?? 0) + "/" + (l.assists ?? 0) : ""
        rows.push(
          '<div class="champ-card"><div class="champ-main"><div><div class="champ-name">' + esc(name) + '</div><div class="sub">' + esc(pick) + (intent ? ' · intencao ' + esc(intent) : '') + '</div></div><span class="pill ' + (side === "ALLY" ? "blue" : "red") + '">' + esc(pos) + '</span></div>' +
          '<div class="champ-meta">' +
          (a.elo?.label ? '<span class="pill">' + esc(a.elo.label) + '</span>' : '') +
          (Number.isFinite(a.mmr) ? '<span class="pill">~' + esc(a.mmr) + '</span>' : '') +
          (Number.isFinite(l?.netWorth) ? '<span class="pill yellow">' + Number(l.netWorth).toLocaleString("pt-BR") + 'g</span>' : '') +
          (Number.isFinite(l?.level) ? '<span class="pill">Lv ' + esc(l.level) + '</span>' : '') +
          (Number.isFinite(l?.cs) ? '<span class="pill">CS ' + esc(l.cs) + '</span>' : '') +
          (kda ? '<span class="pill">' + esc(kda) + '</span>' : '') +
          (!l ? '<span class="pill yellow">aguardando live</span>' : '') +
          '</div></div>'
        )
      }
      return rows.join("")
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

    function renderAnalysisPanel(team, extremes) {
      const cards = []
      for (const [i, p] of extremes.filter(Boolean).entries()) {
        cards.push('<div class="metric"><label>' + (i === 0 ? 'Maior elo' : 'Menor elo') + '</label><strong>' + esc(p.summonerName || "-") + '</strong><div class="sub">' + esc(p.elo || "-") + ' · ~' + esc(p.mmr ?? "-") + '</div></div>')
      }
      const risky = team.filter(p => (p.smurfFlags || []).length || (p.streak?.type && p.streak.count >= 3))
      for (const p of risky) cards.push('<div class="alert yellow">' + analysisLine(p) + '</div>')
      return cards.join("") || '<div class="empty">Aguardando loading analysis</div>'
    }

    function analysisLine(p) {
      const flags = (p.smurfFlags || []).map(f => f.label).join(", ")
      const streak = p.streak?.type && p.streak.count >= 3 ? '<span class="pill ' + (p.streak.type === "win" ? "green" : "red") + '">' + p.streak.count + (p.streak.type === "win" ? "W" : "L") + '</span>' : ""
      const level = p.level ? 'Lv ' + p.level : 'Lv ?'
      const wr = p.elo?.reliableWinRate ? ' · ' + p.elo.winRate + '% WR / ' + p.elo.totalGames + 'j' : ''
      return '<div class="alert-title">' + esc(p.summonerName || "-") + '</div><div class="sub">' + esc(p.elo?.label || "-") + ' · ~' + esc(p.mmr || "-") + ' · ' + level + wr + '</div>' + streak + (flags ? '<div class="sub">' + esc(flags) + '</div>' : '')
    }

    function renderAlerts(s) {
      const alerts = []
      alerts.push(...loadingAlerts(s.latestLoading))
      alerts.push(...gameAlerts(s.latestLoading, s.latestScoreboard, s.latestScoreboardAt, s.latestGameUpdate, s.events || []))
      const unique = dedupeAlerts(alerts).slice(0, 24)
      $("alert-count").textContent = unique.length
      $("alerts").innerHTML = unique.map(a =>
        '<div class="alert ' + esc(a.kind || "yellow") + '"><div class="alert-title">' + esc(a.title) + '</div><div class="sub">' + esc(a.detail) + '</div></div>'
      ).join("") || '<div class="empty">Sem alertas agora</div>'
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

    function loadingAlerts(loading) {
      if (!loading) return []
      const out = []
      const analysis = loading.analysis || {}
      for (const s of analysis.streakAlerts || []) {
        out.push({
          kind: s.type === "win" ? "green" : "red",
          title: s.summonerName + " em " + s.count + (s.type === "win" ? " wins" : " losses"),
          detail: (s.team === "ALLY" ? "Aliado" : "Inimigo") + " · ultimas: " + (s.recent || []).join(""),
        })
      }
      for (const s of analysis.smurfSuspects || []) {
        out.push({
          kind: "yellow",
          title: "Possivel smurf: " + s.summonerName,
          detail: (s.team === "ALLY" ? "Aliado" : "Inimigo") + " · Lv " + s.level + " · ~" + s.mmr + " MMR · " + (s.flags || []).map(f => f.label).join(", "),
        })
      }
      for (const p of [...(loading.myTeam || []), ...(loading.enemyTeam || [])]) {
        const total = Number(p.elo?.totalGames ?? 0)
        const wr = Number(p.elo?.winRate ?? 0)
        if (total >= 10 && total < 120 && wr >= 62) {
          out.push({
            kind: p.isMe ? "blue" : "yellow",
            title: "Win rate alto: " + (p.summonerName || "?"),
            detail: (p.isMe ? "Voce" : "Jogador") + " · " + wr + "% WR em " + total + " jogos",
          })
        }
      }
      for (const a of analysis.autofillSuspects || []) {
        out.push({
          kind: "yellow",
          title: "Autofill possivel: " + a.summonerName,
          detail: (a.team === "ALLY" ? "Aliado" : "Inimigo") + " · " + a.assignedPosition + " · spells " + (a.spells || []).join("/"),
        })
      }
      return out
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
      if (Number.isFinite(Number(teamGold.difference)) && me.team) {
        const signedGold = teamGold.leading === me.team ? Number(teamGold.difference) : -Number(teamGold.difference)
        if (signedGold >= 2000) out.push({ kind: "green", title: "Seu time + " + signedGold.toLocaleString("pt-BR") + "g", detail: "Vantagem geral no snapshot " + fmt(gameTime) })
        if (signedGold <= -2000) out.push({ kind: "red", title: "Seu time " + signedGold.toLocaleString("pt-BR") + "g", detail: "Desvantagem geral no snapshot " + fmt(gameTime) })
      }

      const allyCarry = topBy(ally, "netWorth")
      if (allyCarry && Number(allyCarry.netWorth) >= 12000) {
        out.push({ kind: "green", title: "Carry aliado forte: " + allyCarry.summonerName, detail: allyCarry.championName + " · " + Number(allyCarry.netWorth).toLocaleString("pt-BR") + "g" })
      }
      const enemyThreat = enemy.find(p => Number(p.kills ?? 0) >= 5 && Number(p.deaths ?? 0) <= 1)
      if (enemyThreat) {
        out.push({ kind: "red", title: "Ameaca inimiga: " + enemyThreat.summonerName, detail: enemyThreat.championName + " · KDA " + enemyThreat.kills + "/" + enemyThreat.deaths + "/" + enemyThreat.assists })
      }

      for (const a of ally) {
        if (gameTime <= 360 && Number(a.deaths ?? 0) >= 2) {
          out.push({ kind: "red", title: a.summonerName + " morreu " + a.deaths + "x antes dos 6 min", detail: a.championName + " · early game em risco" })
        }
      }

      for (let i = 0; i < ally.length; i++) {
        const a = ally[i]
        const aInfo = findAnalysisForLive(a, allyAnalysis, i)
        const enemyMatch = findEnemyMatch(aInfo, enemy, enemyAnalysis, i)
        if (!isComparablePair(a, enemyMatch)) continue

        const goldDiff = Number(enemyMatch.netWorth) - Number(a.netWorth)
        if (goldDiff >= 2000) {
          out.push({ kind: "red", title: a.summonerName + " esta " + goldDiff.toLocaleString("pt-BR") + "g atras", detail: a.championName + " vs " + enemyMatch.championName + " · snapshot " + fmt(scoreboard.gameTime) })
        }
        const levelDiff = Number(enemyMatch.level) - Number(a.level)
        if (levelDiff >= 2) {
          out.push({ kind: "red", title: a.summonerName + " esta " + levelDiff + " niveis atras", detail: "Lv " + a.level + " contra Lv " + enemyMatch.level + " · snapshot " + fmt(scoreboard.gameTime) })
        }
        const csDiff = Number(enemyMatch.cs) - Number(a.cs)
        if (csDiff >= 50) {
          out.push({ kind: "yellow", title: a.summonerName + " esta " + csDiff + " CS atras", detail: a.championName + " vs " + enemyMatch.championName + " · snapshot " + fmt(scoreboard.gameTime) })
        }
        if (gameTime >= 600 && gameTime <= 780 && isBotLane(aInfo) && csDiff >= 30) {
          out.push({ kind: "yellow", title: "Bot lane " + csDiff + " CS atras aos 10 min", detail: a.championName + " vs " + enemyMatch.championName })
        }
        const itemDiff = itemCount(enemyMatch) - itemCount(a)
        if (itemDiff >= 2) {
          out.push({ kind: "yellow", title: a.summonerName + " com spike de item atrasado", detail: enemyMatch.championName + " tem +" + itemDiff + " itens no snapshot " + fmt(scoreboard.gameTime) })
        } else if (itemDiff <= -2) {
          out.push({ kind: "green", title: a.summonerName + " com spike de item", detail: a.championName + " tem +" + Math.abs(itemDiff) + " itens contra " + enemyMatch.championName })
        }
      }

      const allyJungle = findByPosition(ally, allyAnalysis, "JUNGLE")
      const enemyJungle = findByPosition(enemy, enemyAnalysis, "JUNGLE")
      if (isComparablePair(allyJungle, enemyJungle)) {
        const jgLevel = Number(enemyJungle.level) - Number(allyJungle.level)
        const jgCs = Number(enemyJungle.cs) - Number(allyJungle.cs)
        if (jgLevel >= 2) out.push({ kind: "red", title: "Jungle aliado " + jgLevel + " niveis atras", detail: allyJungle.summonerName + " vs " + enemyJungle.summonerName })
        if (jgCs >= 20) out.push({ kind: "yellow", title: "Jungle aliado " + jgCs + " CS atras", detail: allyJungle.summonerName + " vs " + enemyJungle.summonerName })
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
          out.push({ kind: "blue", title: "1 min para " + def.label, detail: "Nasce em " + fmt(remaining) + " · tempo de jogo " + fmt(gameTime) })
        }
        if (remaining <= 0 && remaining >= -45) {
          out.push({ kind: "blue", title: def.label + " disponivel", detail: "Janela aberta ha " + fmt(Math.abs(remaining)) })
        }
        if (context && remaining <= 60 && remaining >= -30) {
          const deadEnemies = context.liveEnemy.filter(p => p.isDead).length
          const deadAllies = context.liveAlly.filter(p => p.isDead).length
          if (deadEnemies >= 3) out.push({ kind: "green", title: "Janela de " + def.label, detail: deadEnemies + " inimigos mortos perto do objetivo" })
          else if (deadEnemies >= 2) out.push({ kind: "blue", title: "Possivel janela de " + def.label, detail: deadEnemies + " inimigos mortos perto do objetivo" })
          if (deadAllies >= 3) out.push({ kind: "red", title: "Evitar luta por " + def.label, detail: deadAllies + " aliados mortos perto do objetivo" })
          const allyJg = findByPosition(context.liveAlly, context.allyAnalysis, "JUNGLE")
          const enemyJg = findByPosition(context.liveEnemy, context.enemyAnalysis, "JUNGLE")
          if (allyJg?.isDead) out.push({ kind: "red", title: "Jungler aliado morto antes de " + def.label, detail: allyJg.summonerName + " sem pressao de smite" })
          if (enemyJg?.isDead) out.push({ kind: "green", title: "Jungler inimigo morto antes de " + def.label, detail: enemyJg.summonerName + " sem pressao de smite" })
        }
      }
      const dragons = events.filter(e => e.event_type === "objective" && e.data?.type === "dragon").length
      if (dragons >= 3) out.push({ kind: "yellow", title: "Checar soul point", detail: dragons + " dragoes registrados nesta partida" })
      const earlyTower = events.find(e => e.event_type === "objective" && e.data?.type === "tower" && Number(e.data?.eventTime ?? 9999) <= 840)
      if (earlyTower) out.push({ kind: "yellow", title: "Torre caiu antes de 14 min", detail: "Plates/rota podem ter aberto cedo" })
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

    function itemCount(player) {
      const ignored = new Set([3340, 3363, 3364, 2055, 2003, 2031, 2138, 2139, 2140])
      return (player?.items || []).filter(i => !ignored.has(Number(i.id))).length
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
      if (type === "post_game_analysis") return d.status === "pronto" ? "Analise pronta: " + (d.analysis?.resumo || "") : "Analise pos-jogo " + (d.status || "")
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
      if (p?.puuid) onlineUsers.set(p.puuid, { puuid: p.puuid, gameName: p.gameName, tagLine: p.tagLine, phase: p.phase, since: p.since })
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

server.listen(PORT, () => {
  console.log(`[watch-ui] IDV Watch UI aberta em http://localhost:${PORT}`)
})

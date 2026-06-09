import { createClient } from "@supabase/supabase-js"
import readline from "readline"
import { config } from "dotenv"
config()

const SUPABASE_URL      = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL ou SUPABASE_ANON_KEY nÃ£o definidos no .env")
  process.exit(1)
}

const R = "\x1b[0m"; const B = "\x1b[1m"; const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"; const GREEN = "\x1b[32m"; const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"; const GRAY = "\x1b[90m"; const BLUE = "\x1b[34m"
const MAGENTA = "\x1b[35m"; const WHITE = "\x1b[97m"

function ts() { return `${GRAY}[${new Date().toLocaleTimeString("pt-BR")}]${R}` }
function mins(s: number) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` }

function spellName(id: unknown) {
  const spells: Record<number, string> = {
    1: "Cleanse",
    3: "Exhaust",
    4: "Flash",
    6: "Ghost",
    7: "Heal",
    11: "Smite",
    12: "Teleport",
    13: "Clarity",
    14: "Ignite",
    21: "Barrier",
    32: "Mark",
    39: "Mark",
    54: "Placeholder",
    55: "Placeholder",
  }
  const n = Number(id)
  return spells[n] ? `${spells[n]} (${n})` : `Spell ${Number.isFinite(n) ? n : "?"}`
}
function fmt(event_type: string, puuid: string, data: Record<string, unknown>): string {
  const id = `${GRAY}${puuid.slice(0, 8)}...${R}`
  const lines: string[] = []

  switch (event_type) {
    case "champ_hover": {
      const pos  = data.position ? ` Â· ${data.position}` : ""
      const jg   = data.isJungle ? ` ${YELLOW}[Jungle]${R}` : ""
      const t    = data.timeLeftInPhase ? ` â± ${data.timeLeftInPhase}s` : ""
      const name = (data.championName as string) ?? `ID ${data.championId}`
      lines.push(`${ts()} ðŸ‘ï¸  ${CYAN}${B}champ_hover${R}  ${id}`)
      lines.push(`   ${B}${name}${R}${pos}${jg}${t}`)
      break
    }

    case "champ_select_complete": {
      lines.push(`${ts()} ðŸŽ® ${GREEN}${B}champ_select_complete${R}  ${id}`)
      const jg = data.isJungle ? ` ${YELLOW}[Jungle]${R}` : ""
      lines.push(`   ${B}Meu pick:${R} ${B}${data.myChampionName ?? `ID ${data.myChampionId}`}${R} Â· ${data.myPosition}${jg}`)
      lines.push(`   ${B}Spells:${R} ${spellName(data.spell1Id)} + ${spellName(data.spell2Id)}`)

      const runes = data.runes as Record<string, unknown> | null
      if (runes) {
        lines.push(`   ${B}Runas:${R} ${runes.name ?? "?"} (primary ${runes.primaryStyleId} / sub ${runes.subStyleId})`)
      }

      const myTeam = (data.myTeam as Array<Record<string, unknown>>) ?? []
      if (myTeam.length) {
        const picks = myTeam.filter(p => (p.championId as number) > 0)
          .map(p => `${p.championName ?? `ID ${p.championId}`} (${p.position ?? "?"})`)
        lines.push(`   ${B}Time:${R} ${picks.join("  | ")}`)
      }

      const bans = data.bans as { myTeam: string[]; enemyTeam: string[]; myTeamIds?: number[]; enemyTeamIds?: number[] } | undefined
      if (bans) {
        const mine = bans.myTeam.length ? bans.myTeam.join(", ") : `${GRAY}indisponivel${R}`
        const enemy = bans.enemyTeam.length ? bans.enemyTeam.join(", ") : `${GRAY}indisponivel${R}`
        lines.push(`   ${B}Bans nossos:${R} ${mine}  ${B}Bans inimigos:${R} ${enemy}`)
      }
      break
    }

    case "loading_analysis": {
      type EloSpot = { summonerName: string; elo: string; mmr: number; level?: number; team?: string } | null
      const analysis = data.analysis as {
        myTeamAvgMmr: number
        enemyTeamAvgMmr: number
        mmrDifference: number
        favoredTeam: string
        highestEloMyTeam?: EloSpot
        lowestEloMyTeam?: EloSpot
        highestEloEnemyTeam?: EloSpot
        lowestEloEnemyTeam?: EloSpot
        autofillSuspects: Array<{ summonerName: string; assignedPosition: string; spells: number[]; team: string }>
        smurfSuspects: Array<{ summonerName: string; level: number; mmr: number; flags: Array<{ code: string; label: string }>; team: string }>
        streakAlerts?: Array<{ summonerName: string; team: string; type: "win" | "loss"; count: number; recent: string[] }>
      }
      const myTeam = (data.myTeam as Array<{
        summonerName: string; assignedPosition: string; championId?: number
        elo: { label: string }; mmr: number; level: number; isMe: boolean
        smurfFlags: Array<{ label: string }>
        streak?: { type: string | null; count: number; recent: string[] }
      }>) ?? []
      const enemyTeam = (data.enemyTeam as typeof myTeam) ?? []

      const favor = analysis.favoredTeam === "ALLY"
        ? `${GREEN}+${Math.abs(analysis.mmrDifference)} MMR (aliados)${R}`
        : `${RED}+${Math.abs(analysis.mmrDifference)} MMR (inimigos)${R}`

      lines.push(`${ts()} ${CYAN}${B}loading_analysis${R}  ${id}`)
      lines.push(`   ${B}MMR estimado:${R} Aliados ${YELLOW}${B}${analysis.myTeamAvgMmr}${R} x Inimigos ${YELLOW}${B}${analysis.enemyTeamAvgMmr}${R} - ${favor}`)

      const spot = (label: string, p?: EloSpot) => p
        ? `${label}: ${B}${p.summonerName}${R} ${DIM}${p.elo}${R} ~${p.mmr}`
        : `${label}: ${GRAY}indisponivel${R}`

      if (analysis.highestEloMyTeam || analysis.lowestEloMyTeam || analysis.highestEloEnemyTeam || analysis.lowestEloEnemyTeam) {
        lines.push(`   ${spot("Maior elo aliado", analysis.highestEloMyTeam)}  |  ${spot("Menor elo aliado", analysis.lowestEloMyTeam)}`)
        lines.push(`   ${spot("Maior elo inimigo", analysis.highestEloEnemyTeam)}  |  ${spot("Menor elo inimigo", analysis.lowestEloEnemyTeam)}`)
      } else if (analysis.lowestEloMyTeam) {
        lines.push(`   ${spot("Menor elo aliado", analysis.lowestEloMyTeam)}`)
      }

      const streakAlerts = analysis.streakAlerts ?? []
      if (streakAlerts.length) {
        lines.push(`   ${B}Streak 3+:${R}`)
        for (const s of streakAlerts) {
          const side = s.team === "ALLY" ? "Aliado" : "Inimigo"
          const color = s.type === "win" ? GREEN : RED
          const kind = s.type === "win" ? "wins" : "losses"
          lines.push(`   ${side} ${color}${s.summonerName}${R} - ${s.count} ${kind} (${s.recent.join("")})`)
        }
      }

      const fmtP = (p: typeof myTeam[0], side: string) => {
        const me = p.isMe ? ` ${YELLOW}< VOCE${R}` : ""
        const flags = p.smurfFlags?.length ? ` ${RED}! ${p.smurfFlags.map(f => f.label).join(", ")}${R}` : ""
        const streak = p.streak?.type && p.streak.count >= 3
          ? ` ${p.streak.type === "win" ? GREEN : RED}${p.streak.count}${p.streak.type === "win" ? "W" : "L"}${R}`
          : ""
        const pos = p.assignedPosition ? ` [${p.assignedPosition}]` : ""
        return `  ${side} ${B}${p.summonerName || "?"}${R}${pos}${me}  ${DIM}${p.elo?.label ?? "?"}${R} ~${p.mmr}${streak}${flags}`
      }

      lines.push(`   ${B}Aliados:${R}`)
      for (const p of myTeam) lines.push(fmtP(p, "A"))
      lines.push(`   ${B}Inimigos:${R}`)
      for (const p of enemyTeam) lines.push(fmtP(p, "E"))

      if (analysis.autofillSuspects?.length) {
        lines.push(`   ${B}Autofill?${R}`)
        for (const a of analysis.autofillSuspects) {
          const side = a.team === "ALLY" ? "Aliado" : "Inimigo"
          lines.push(`   ${side} ${YELLOW}${a.summonerName}${R} - ${a.assignedPosition} (spells: ${a.spells.join(", ")})`)
        }
      }

      if (analysis.smurfSuspects?.length) {
        lines.push(`   ${B}Suspeitos de smurf:${R}`)
        for (const s of analysis.smurfSuspects) {
          const side = s.team === "ALLY" ? "Aliado" : "Inimigo"
          lines.push(`   ${side} ${RED}${s.summonerName}${R} Lv${s.level} ~${s.mmr} MMR`)
          for (const f of s.flags) lines.push(`      -> ${f.label}`)
        }
      }
      break
    }

    case "gameflow_phase": {
      lines.push(`${ts()} ${CYAN}${B}gameflow${R}  ${id}`)
      lines.push(`   ${data.previousPhase ?? "?"} -> ${data.phase ?? "?"}`)
      break
    }
    case "game_start":
    case "game_update": {
      const isStart = event_type === "game_start"
      const icon = isStart ? "âš”ï¸ " : "ðŸ“Š"
      const color = isStart ? GREEN : BLUE
      const me = data.me as Record<string, unknown>
      const score = data.score as { order: number; chaos: number }
      const teamCS = data.teamCS as { order: number; chaos: number } | undefined
      lines.push(`${ts()} ${icon} ${color}${B}${event_type}${R}  ${id}`)
      lines.push(
        `   ${B}${me?.summonerName ?? "?"}${R}  ` +
        `${YELLOW}${mins(data.gameTime as number)}${R}  ` +
        `KDA: ${GREEN}${me?.kills}/${me?.deaths}/${me?.assists}${R}  ` +
        `CS: ${me?.cs} (${me?.cspm}/min)  ` +
        `Gold: ${YELLOW}${me?.gold}${R}  ` +
        `KP: ${me?.killParticipation}%`
      )
      lines.push(`   HP mÃ¡x: ${me?.maxHp}  Lv: ${me?.level}`)
      if (me?.abilities) {
        const ab = me.abilities as Record<string, number>
        lines.push(`   Abilities: Q${ab.Q} W${ab.W} E${ab.E} R${ab.R}`)
      }
      lines.push(`   ðŸ”µ ${B}${score?.order}${R}  Ã—  ${B}${score?.chaos}${R} ðŸ”´${teamCS ? `  CS times: ${teamCS.order} Ã— ${teamCS.chaos}` : ""}`)
      break
    }

    case "first_blood": {
      const isMe = data.isMe ? `  ${YELLOW}â† VOCÃŠ${R}` : ""
      lines.push(`${ts()} ðŸ©¸ ${RED}${B}first_blood${R}  ${id}`)
      lines.push(`   ${data.recipient}${isMe}  @${mins(data.eventTime as number)}`)
      break
    }

    case "kill": {
      const killing  = data.isMeKilling  ? `  ${GREEN}â† VOCÃŠ MATOU${R}` : ""
      const dying    = data.isMeDying    ? `  ${RED}â† VOCÃŠ MORREU${R}` : ""
      const assisting = data.isMeAssisting ? `  ${CYAN}â† SUA ASSIST${R}` : ""
      const assists  = (data.assisters as string[]).length ? ` (assists: ${(data.assisters as string[]).join(", ")})` : ""
      lines.push(`${ts()} âš”ï¸  ${WHITE}${B}kill${R}  ${id}`)
      lines.push(`   ${data.killer} â†’ ${data.victim}${assists}  @${mins(data.eventTime as number)}${killing}${dying}${assisting}`)
      break
    }

    case "multikill": {
      lines.push(`${ts()} ðŸ”¥ ${YELLOW}${B}multikill${R}  ${id}`)
      lines.push(`   ${B}${data.label}${R} por ${data.killer}  @${mins(data.eventTime as number)}`)
      break
    }

    case "objective": {
      const icons: Record<string, string> = {
        dragon: "ðŸ‰", baron: "ðŸŸ£", herald: "ðŸ”®",
        tower: "ðŸ°", inhibitor: "ðŸ’Ž", ace: "ðŸ’€",
        void_grub: "ðŸª±", atakhan: "ðŸ©¸",
      }
      const icon = icons[data.type as string] ?? "ðŸŽ¯"
      const stolen = data.stolen ? ` ${RED}ROUBADO${R}` : ""
      const dragon = data.dragonType ? ` (${data.dragonType})` : ""
      lines.push(`${ts()} ${icon} ${MAGENTA}${B}objective: ${data.type}${R}${dragon}  ${id}`)
      if (data.type === "ace") {
        lines.push(`   Time ${data.acingTeam} deu ace por ${data.acer}  @${mins(data.eventTime as number)}`)
      } else {
        lines.push(`   ${data.killer}${stolen}  @${mins(data.eventTime as number)}`)
      }
      break
    }

    case "scoreboard": {
      const tg = data.teamGold as { order: number; chaos: number; difference: number; leading: string } | undefined
      const players = data.players as Array<{
        summonerName: string; championName: string; team: string
        level: number; kills: number; deaths: number; assists: number
        cs: number; netWorth?: number; isMe: boolean
        items: Array<{ id: number; name: string }>
      }>
      const fmt_g = (n: number) => n.toLocaleString("pt-BR")

      lines.push(`${ts()} ðŸ’° ${YELLOW}${B}scoreboard${R}  ${id}`)
      if (tg) {
        lines.push(
          `   ORDER ${B}${fmt_g(tg.order)}g${R}` +
          `   ${tg.leading === "ORDER" ? GREEN : RED}+${fmt_g(tg.difference)}g${R}` +
          `   ${B}${fmt_g(tg.chaos)}g${R} CHAOS`
        )
      }
      lines.push(`   ${"â”€".repeat(60)}`)

      const order = players.filter(p => p.team === "ORDER")
      const chaos = players.filter(p => p.team === "CHAOS")

      const fmtPlayer = (p: typeof players[0]) => {
        const me = p.isMe ? ` ${YELLOW}â—€${R}` : ""
        const kda = `${GREEN}${p.kills}/${p.deaths}/${p.assists}${R}`
        const name = `${B}${p.championName.padEnd(12)}${R}`
        const worth = Number.isFinite(p.netWorth) ? `  ${YELLOW}${fmt_g(p.netWorth!)}g${R}` : ""
        const items = p.items?.length ? `  Items: ${p.items.map(i => i.name || i.id).join(", ")}` : ""
        return `${name} Lv${p.level} KDA ${kda}  CS ${String(p.cs).padStart(3)}${worth}${me}${items}`
      }

      const maxLen = Math.max(order.length, chaos.length)
      for (let i = 0; i < maxLen; i++) {
        const o = order[i]
        const c = chaos[i]
        const left  = o ? `  ðŸ”µ ${fmtPlayer(o)}` : ""
        const right = c ? `  ðŸ”´ ${fmtPlayer(c)}` : ""
        lines.push(left)
        lines.push(right)
      }
      break
    }

    case "raw_lol_event": {
      return ""
    }
    case "game_end": {
      lines.push(`${ts()} ðŸ ${GRAY}${B}game_end${R}  ${id}`)
      lines.push(`   DuraÃ§Ã£o: ${mins(data.gameTime as number)}`)
      break
    }

    default: {
      lines.push(`${ts()} â€¢  ${DIM}${event_type}${R}  ${id}`)
      lines.push(`   ${JSON.stringify(data).slice(0, 100)}`)
    }
  }

  return lines.join("\n")
}

// â”€â”€â”€ UsuÃ¡rios online â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface PresenceState {
  gameName: string
  tagLine:  string
  phase:    string
  since:    string
}

const onlineUsers = new Map<string, PresenceState>()  // keyed by puuid
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>()

function printOnlineStatus() {
  if (onlineUsers.size === 0) {
    console.log(`\n${GRAY}Nenhum agent online agora${R}\n`)
    return
  }
  console.log(`\n${B}ðŸŸ¢ Agents online (${onlineUsers.size}):${R}`)
  for (const [puuid, u] of onlineUsers) {
    const name  = u.gameName ? `${CYAN}${B}${u.gameName}#${u.tagLine}${R}` : `${GRAY}${puuid.slice(0, 8)}...${R}`
    const phase = u.phase === "LoLClosed"
      ? ` ${RED}[LoL fechado]${R}`
      : u.phase !== "None" && u.phase !== "Lobby" ? ` ${YELLOW}[${u.phase}]${R}` : ""
    console.log(`  ${name}${phase}`)
  }
  console.log()
}

// â”€â”€â”€ Teclado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)

process.stdin.on("keypress", (_ch: string, key: { name: string; ctrl: boolean }) => {
  if (!key) return
  if (key.ctrl && key.name === "c") process.exit()
  if (key.name === "p") { printOnlineStatus(); return }
})

// â”€â”€â”€ Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
console.log(`\n${B}lol-agent watcher${R} â€” aguardando eventos`)
console.log(`${DIM}[p] agents online${R}\n`)

// PresenÃ§a â€” quem estÃ¡ rodando o agent agora
const presenceChan = supabase.channel("idv-agent-presence")

function syncPresenceState(logChanges = false) {
  const state = presenceChan.presenceState<PresenceState & { puuid: string }>()
  const nextUsers = new Map<string, PresenceState>()

  for (const presences of Object.values(state)) {
    const p = presences[presences.length - 1]
    if (p?.puuid) nextUsers.set(p.puuid, { gameName: p.gameName, tagLine: p.tagLine, phase: p.phase, since: p.since })
  }

  for (const [puuid, user] of nextUsers) {
    const timer = offlineTimers.get(puuid)
    if (timer) {
      clearTimeout(timer)
      offlineTimers.delete(puuid)
    }

    const previous = onlineUsers.get(puuid)
    const wasOnline = !!previous
    onlineUsers.set(puuid, user)

    if (logChanges && wasOnline && previous?.phase !== user.phase) {
      const name = user.gameName ? `${CYAN}${B}${user.gameName}#${user.tagLine}${R}` : puuid.slice(0, 8)
      if (user.phase === "LoLClosed") {
        console.log(`\n${ts()} ðŸ”Œ ${RED}League Client fechado:${R} ${name} ${GRAY}(agent ainda online)${R}\n`)
      } else if (previous?.phase === "LoLClosed") {
        console.log(`\n${ts()} ðŸ” ${GREEN}League Client voltou:${R} ${name} ${YELLOW}[${user.phase}]${R}\n`)
      }
    }

    if (logChanges && !wasOnline) {
      const name = user.gameName ? `${CYAN}${B}${user.gameName}#${user.tagLine}${R}` : puuid.slice(0, 8)
      console.log(`\n${ts()} ðŸŸ¢ ${GREEN}Agent online:${R} ${name}\n`)
    }
  }

  for (const [puuid, user] of onlineUsers) {
    if (nextUsers.has(puuid) || offlineTimers.has(puuid)) continue

    const timer = setTimeout(() => {
      offlineTimers.delete(puuid)
      if (!onlineUsers.has(puuid)) return

      const currentState = presenceChan.presenceState<PresenceState & { puuid: string }>()
      const stillPresent = Object.values(currentState).some(presences => presences.some(p => p.puuid === puuid))
      if (stillPresent) return

      onlineUsers.delete(puuid)
      const name = user.gameName ? `${CYAN}${B}${user.gameName}#${user.tagLine}${R}` : puuid.slice(0, 8)
      console.log(`\n${ts()} ðŸ”´ ${GRAY}Agent offline:${R} ${name}\n`)
    }, 15_000)

    offlineTimers.set(puuid, timer)
  }
}

presenceChan
  .on("presence", { event: "sync" }, () => {
    syncPresenceState(true)
  })
  .on("presence", { event: "join" }, ({ newPresences }) => {
    syncPresenceState(true)
  })
  .on("presence", { event: "leave" }, ({ leftPresences }) => {
    syncPresenceState(true)
  })
  .subscribe((status) => {
    if (status === "SUBSCRIBED") {
      syncPresenceState()
      console.log(`${GREEN}âœ“ PresenÃ§a conectada${onlineUsers.size > 0 ? ` â€” ${onlineUsers.size} online` : ""}${R}`)
    }
  })

supabase
  .channel("live_game_events_watch")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "live_game_events" },
    (payload) => {
      const row = payload.new as { puuid: string; event_type: string; data: Record<string, unknown> }

      try {
        const formatted = fmt(row.event_type, row.puuid, row.data)
        if (formatted) {
          console.log(formatted)
          console.log()
        }
      } catch (e) {
        console.error(`[watcher] Erro ao formatar ${row.event_type}:`, e)
      }
    }
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log(`${GREEN}âœ“ Conectado â€” monitorando live_game_events${R}\n`)
    else if (status === "CHANNEL_ERROR") {
      console.error(`${RED}âœ— Erro Supabase Realtime; reiniciando watcher${R}`)
      process.exit(1)
    }
  })

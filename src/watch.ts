import { createClient } from "@supabase/supabase-js"
import readline from "readline"
import { config } from "dotenv"
config()

const SUPABASE_URL      = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("SUPABASE_URL ou SUPABASE_ANON_KEY não definidos no .env")
  process.exit(1)
}

const R = "\x1b[0m"; const B = "\x1b[1m"; const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"; const GREEN = "\x1b[32m"; const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"; const GRAY = "\x1b[90m"; const BLUE = "\x1b[34m"
const MAGENTA = "\x1b[35m"; const WHITE = "\x1b[97m"

function ts() { return `${GRAY}[${new Date().toLocaleTimeString("pt-BR")}]${R}` }
function mins(s: number) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` }

function fmt(event_type: string, puuid: string, data: Record<string, unknown>): string {
  const id = `${GRAY}${puuid.slice(0, 8)}...${R}`
  const lines: string[] = []

  switch (event_type) {
    case "champ_hover": {
      const pos  = data.position ? ` · ${data.position}` : ""
      const jg   = data.isJungle ? ` ${YELLOW}[Jungle]${R}` : ""
      const t    = data.timeLeftInPhase ? ` ⏱ ${data.timeLeftInPhase}s` : ""
      const name = (data.championName as string) ?? `ID ${data.championId}`
      lines.push(`${ts()} 👁️  ${CYAN}${B}champ_hover${R}  ${id}`)
      lines.push(`   ${B}${name}${R}${pos}${jg}${t}`)
      break
    }

    case "champ_select_complete": {
      lines.push(`${ts()} 🎮 ${GREEN}${B}champ_select_complete${R}  ${id}`)
      const jg = data.isJungle ? ` ${YELLOW}[Jungle]${R}` : ""
      lines.push(`   ${B}Meu pick:${R} ${B}${data.myChampionName ?? `ID ${data.myChampionId}`}${R} · ${data.myPosition}${jg}`)
      lines.push(`   ${B}Spell 1:${R} ${data.spell1Id}  ${B}Spell 2:${R} ${data.spell2Id}`)

      const runes = data.runes as Record<string, unknown> | null
      if (runes) {
        lines.push(`   ${B}Runas:${R} ${runes.name ?? "?"} (primary ${runes.primaryStyleId} / sub ${runes.subStyleId})`)
      }

      const myTeam = (data.myTeam as Array<Record<string, unknown>>) ?? []
      if (myTeam.length) {
        const picks = myTeam.filter(p => (p.championId as number) > 0)
          .map(p => `${p.championId}(${p.position})`)
        lines.push(`   ${B}Time:${R} ${picks.join("  ")}`)
      }

      const bans = data.bans as { myTeam: number[]; enemyTeam: number[] } | undefined
      if (bans) {
        lines.push(`   ${B}Bans nossos:${R} ${bans.myTeam.join(" ")}  ${B}Bans inimigos:${R} ${bans.enemyTeam.join(" ")}`)
      }
      break
    }

    case "loading_analysis": {
      const analysis = data.analysis as {
        myTeamAvgMmr: number; enemyTeamAvgMmr: number; mmrDifference: number; favoredTeam: string
        lowestEloMyTeam: { summonerName: string; elo: string; mmr: number } | null
        autofillSuspects: Array<{ summonerName: string; assignedPosition: string; spells: number[]; team: string }>
        smurfSuspects: Array<{ summonerName: string; level: number; mmr: number; flags: Array<{ code: string; label: string }>; team: string }>
      }
      const myTeam    = (data.myTeam    as Array<{ summonerName: string; assignedPosition: string; elo: { label: string }; mmr: number; level: number; isMe: boolean; smurfFlags: Array<{ label: string }> }>) ?? []
      const enemyTeam = (data.enemyTeam as Array<{ summonerName: string; assignedPosition: string; elo: { label: string }; mmr: number; level: number; smurfFlags: Array<{ label: string }> }>) ?? []

      const favor = analysis.favoredTeam === "ALLY"
        ? `${GREEN}+${Math.abs(analysis.mmrDifference)} MMR (aliados)${R}`
        : `${RED}+${Math.abs(analysis.mmrDifference)} MMR (inimigos)${R}`

      lines.push(`${ts()} 🔍 ${CYAN}${B}loading_analysis${R}  ${id}`)
      lines.push(`   ${B}MMR estimado:${R}  🔵 Aliados ${YELLOW}${B}${analysis.myTeamAvgMmr}${R}  × Inimigos ${YELLOW}${B}${analysis.enemyTeamAvgMmr}${R}  — ${favor}`)

      if (analysis.lowestEloMyTeam) {
        const low = analysis.lowestEloMyTeam
        lines.push(`   ${B}Menor elo:${R}  ${RED}${low.summonerName}${R} — ${low.elo} (~${low.mmr} MMR)`)
      }

      lines.push(`   ${"─".repeat(55)}`)

      const fmtP = (p: typeof myTeam[0], sideIcon: string) => {
        const me    = p.isMe ? ` ${YELLOW}◀ VOCÊ${R}` : ""
        const flags = p.smurfFlags ?? []
        const smurf = flags.length ? ` ${RED}⚠ ${flags.map((f: { label: string }) => f.label).join(", ")}${R}` : ""
        const pos   = p.assignedPosition ? ` [${p.assignedPosition}]` : ""
        const elo   = p.elo?.label ?? "?"
        return `  ${sideIcon} ${B}${p.summonerName || "?"}${R}${pos}${me}  ${DIM}${elo}${R} ~${p.mmr}${smurf}`
      }

      lines.push(`   ${B}Aliados:${R}`)
      for (const p of myTeam) lines.push(fmtP(p as typeof myTeam[0] & { isMe: boolean }, "🔵"))

      lines.push(`   ${B}Inimigos:${R}`)
      for (const p of enemyTeam) lines.push(fmtP(p as typeof myTeam[0], "🔴"))

      if (analysis.autofillSuspects.length) {
        lines.push(`   ${B}Autofill?${R}`)
        for (const a of analysis.autofillSuspects) {
          const side = a.team === "ALLY" ? "🔵" : "🔴"
          lines.push(`   ${side} ${YELLOW}${a.summonerName}${R} — ${a.assignedPosition} (spells: ${a.spells.join(", ")})`)
        }
      }

      if (analysis.smurfSuspects.length) {
        lines.push(`   ${B}Suspeitos de smurf:${R}`)
        for (const s of analysis.smurfSuspects) {
          const side = s.team === "ALLY" ? "🔵" : "🔴"
          lines.push(`   ${side} ${RED}${s.summonerName}${R}  Lv${s.level}  ~${s.mmr} MMR`)
          for (const f of s.flags) lines.push(`       → ${f.label}`)
        }
      }
      break
    }

    case "game_start":
    case "game_update": {
      const isStart = event_type === "game_start"
      const icon = isStart ? "⚔️ " : "📊"
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
      lines.push(`   HP máx: ${me?.maxHp}  Lv: ${me?.level}`)
      if (me?.abilities) {
        const ab = me.abilities as Record<string, number>
        lines.push(`   Abilities: Q${ab.Q} W${ab.W} E${ab.E} R${ab.R}`)
      }
      lines.push(`   🔵 ${B}${score?.order}${R}  ×  ${B}${score?.chaos}${R} 🔴${teamCS ? `  CS times: ${teamCS.order} × ${teamCS.chaos}` : ""}`)
      break
    }

    case "first_blood": {
      const isMe = data.isMe ? `  ${YELLOW}← VOCÊ${R}` : ""
      lines.push(`${ts()} 🩸 ${RED}${B}first_blood${R}  ${id}`)
      lines.push(`   ${data.recipient}${isMe}  @${mins(data.eventTime as number)}`)
      break
    }

    case "kill": {
      const killing  = data.isMeKilling  ? `  ${GREEN}← VOCÊ MATOU${R}` : ""
      const dying    = data.isMeDying    ? `  ${RED}← VOCÊ MORREU${R}` : ""
      const assisting = data.isMeAssisting ? `  ${CYAN}← SUA ASSIST${R}` : ""
      const assists  = (data.assisters as string[]).length ? ` (assists: ${(data.assisters as string[]).join(", ")})` : ""
      lines.push(`${ts()} ⚔️  ${WHITE}${B}kill${R}  ${id}`)
      lines.push(`   ${data.killer} → ${data.victim}${assists}  @${mins(data.eventTime as number)}${killing}${dying}${assisting}`)
      break
    }

    case "multikill": {
      lines.push(`${ts()} 🔥 ${YELLOW}${B}multikill${R}  ${id}`)
      lines.push(`   ${B}${data.label}${R} por ${data.killer}  @${mins(data.eventTime as number)}`)
      break
    }

    case "objective": {
      const icons: Record<string, string> = {
        dragon: "🐉", baron: "🟣", herald: "🔮",
        tower: "🏰", inhibitor: "💎", ace: "💀",
        void_grub: "🪱", atakhan: "🩸",
      }
      const icon = icons[data.type as string] ?? "🎯"
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
      const tg = data.teamGold as { order: number; chaos: number; difference: number; leading: string }
      const players = data.players as Array<{
        summonerName: string; championName: string; team: string
        level: number; kills: number; deaths: number; assists: number
        cs: number; netWorth: number; isMe: boolean
        items: Array<{ id: number; name: string }>
      }>
      updateIonianBoots(players)
      const fmt_g = (n: number) => n.toLocaleString("pt-BR")

      lines.push(`${ts()} 💰 ${YELLOW}${B}scoreboard${R}  ${id}`)
      lines.push(
        `   🔵 ORDER ${B}${fmt_g(tg.order)}g${R}` +
        `   ${tg.leading === "ORDER" ? GREEN : RED}▲ ${fmt_g(tg.difference)}g${R}` +
        `   ${B}${fmt_g(tg.chaos)}g${R} CHAOS 🔴`
      )
      lines.push(`   ${"─".repeat(60)}`)

      const order = players.filter(p => p.team === "ORDER")
      const chaos = players.filter(p => p.team === "CHAOS")

      const fmtPlayer = (p: typeof players[0], side: "left" | "right") => {
        const me = p.isMe ? ` ${YELLOW}◀${R}` : ""
        const kda = `${GREEN}${p.kills}/${p.deaths}/${p.assists}${R}`
        const worth = `${YELLOW}${fmt_g(p.netWorth)}g${R}`
        const name = `${B}${p.championName.padEnd(12)}${R}`
        return `${name} Lv${p.level} KDA ${kda}  CS ${String(p.cs).padStart(3)}  ${worth}${me}`
      }

      const maxLen = Math.max(order.length, chaos.length)
      for (let i = 0; i < maxLen; i++) {
        const o = order[i]
        const c = chaos[i]
        const left  = o ? `  🔵 ${fmtPlayer(o, "left")}` : ""
        const right = c ? `  🔴 ${fmtPlayer(c, "right")}` : ""
        lines.push(left)
        lines.push(right)
      }
      break
    }

    case "game_end": {
      lines.push(`${ts()} 🏁 ${GRAY}${B}game_end${R}  ${id}`)
      lines.push(`   Duração: ${mins(data.gameTime as number)}`)
      break
    }

    default: {
      lines.push(`${ts()} •  ${DIM}${event_type}${R}  ${id}`)
      lines.push(`   ${JSON.stringify(data).slice(0, 100)}`)
    }
  }

  return lines.join("\n")
}

// ─── Flash timer ─────────────────────────────────────────────────────────────

const FLASH_ID      = 4
const IONIAN_ID     = 3158
const FLASH_BASE_CD = 300   // segundos

interface FlashState {
  key:          string        // "1"–"5"
  summonerName: string
  cd:           number        // CD efetivo em segundos
  usedAt:       number | null // Date.now() quando usado, null = disponível
}

const flashStates: FlashState[] = []

function cdSecs(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function printFlashStatus() {
  if (flashStates.length === 0) {
    console.log(`\n${GRAY}Sem dados de Flash — aguardando loading_analysis${R}\n`)
    return
  }
  const now = Date.now()
  console.log(`\n${B}⚡ Flash inimigos:${R}`)
  for (const f of flashStates) {
    if (f.usedAt === null) {
      console.log(`  [${f.key}] ${GREEN}${B}DISPONÍVEL${R}  ${f.summonerName}`)
    } else {
      const rem = f.cd * 1000 - (now - f.usedAt)
      console.log(`  [${f.key}] ${RED}${B}${cdSecs(rem)}${R}  ${f.summonerName}`)
    }
  }
  console.log()
}

function markFlash(key: string) {
  const f = flashStates.find(s => s.key === key)
  if (!f) return
  if (f.usedAt !== null) {
    // Segunda pressão = resetar para disponível
    f.usedAt = null
    console.log(`\n${ts()} ⚡ ${GREEN}Flash ${B}${f.summonerName}${R}${GREEN} → DISPONÍVEL (reset manual)${R}\n`)
    return
  }
  f.usedAt = Date.now()
  const boot = f.cd < FLASH_BASE_CD ? ` ${DIM}(Ionian Boots: ${cdSecs(f.cd * 1000)})${R}` : ` ${DIM}(5:00)${R}`
  console.log(`\n${ts()} ⚡ ${RED}Flash usado: ${B}${f.summonerName}${R}${boot}\n`)
}

// Atualiza CD se Ionian Boots detectado no scoreboard
function updateIonianBoots(players: Array<{ summonerName: string; items: Array<{ id: number }> }>) {
  for (const f of flashStates) {
    const p = players.find(pl => pl.summonerName === f.summonerName)
    if (!p) continue
    const hasIonian = p.items.some(i => i.id === IONIAN_ID)
    f.cd = hasIonian ? Math.round(FLASH_BASE_CD * 0.9) : FLASH_BASE_CD
  }
}

// Tick a cada segundo: verifica se algum flash ficou disponível
setInterval(() => {
  const now = Date.now()
  for (const f of flashStates) {
    if (f.usedAt !== null && now - f.usedAt >= f.cd * 1000) {
      f.usedAt = null
      console.log(`\n${ts()} ⚡ ${GREEN}${B}Flash DISPONÍVEL: ${f.summonerName}${R} → pressione [${f.key}] para marcar novo uso\n`)
    }
  }
}, 1_000)

// ─── Teclado ──────────────────────────────────────────────────────────────────

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)

process.stdin.on("keypress", (_ch: string, key: { name: string; ctrl: boolean }) => {
  if (!key) return
  if (key.ctrl && key.name === "c") process.exit()
  if (key.name === "f") { printFlashStatus(); return }
  const n = parseInt(key.name)
  if (n >= 1 && n <= 5) markFlash(String(n))
})

// ─── Supabase ─────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
console.log(`\n${B}lol-agent watcher${R} — aguardando eventos`)
console.log(`${DIM}⚡ Flash: [1-5] marcar uso  [f] ver status  (pressione de novo para resetar)${R}\n`)

supabase
  .channel("live_game_events_watch")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "live_game_events" },
    (payload) => {
      const row = payload.new as { puuid: string; event_type: string; data: Record<string, unknown> }

      // Inicializa flash timer fora do fmt() para não sujar a função de formatação
      if (row.event_type === "loading_analysis") {
        const rawEnemy = (row.data.enemyTeam as Array<{ summonerName: string; spell1Id: number; spell2Id: number }>) ?? []
        const withFlash = rawEnemy.filter(p => p.spell1Id === FLASH_ID || p.spell2Id === FLASH_ID)
        flashStates.length = 0
        withFlash.forEach((p, i) => flashStates.push({
          key: String(i + 1), summonerName: p.summonerName, cd: FLASH_BASE_CD, usedAt: null,
        }))
        if (flashStates.length) {
          console.log(`\n${CYAN}${B}⚡ Flash mapeado:${R}`)
          for (const f of flashStates) console.log(`  [${f.key}] ${f.summonerName}`)
          console.log()
        }
      }

      try {
        console.log(fmt(row.event_type, row.puuid, row.data))
        console.log()
      } catch (e) {
        console.error(`[watcher] Erro ao formatar ${row.event_type}:`, e)
      }
    }
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") console.log(`${GREEN}✓ Conectado — monitorando live_game_events${R}\n`)
    else if (status === "CHANNEL_ERROR") console.error(`${RED}✗ Erro Supabase Realtime${R}`)
  })

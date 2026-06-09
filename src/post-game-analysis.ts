const MODEL = "gemini-2.5-flash"
const KEY_COOLDOWN_MS = 65_000

const keyCooldown = new Map<string, number>()

export type PostGameAnalysis = {
  resumo: string
  foi_bem: string[]
  errou: string[]
  dica: string
  nota: number | string
  rawText?: string
  fallbackReason?: string
}

export type EndGameSnapshot = {
  summonerName?: string
  championName?: string
  position?: string
  result?: string
  duration?: number
  me?: Record<string, unknown>
  score?: Record<string, unknown>
  teamGold?: Record<string, unknown>
  teamCS?: Record<string, unknown>
  loading?: Record<string, unknown> | null
  scoreboard?: Record<string, unknown> | null
  gameUpdate?: Record<string, unknown> | null
  events?: Array<{ event_type: string; data: Record<string, unknown>; created_at?: string }>
}

// ─── Gemini client ────────────────────────────────────────────────────────────

function apiKeys() {
  const csv = process.env.GOOGLE_API_KEYS || process.env.GEMINI_API_KEYS
  if (csv) return csv.split(",").map(k => k.trim()).filter(Boolean)

  const indexed: string[] = []
  for (let i = 1; i <= 10; i++) {
    const google = process.env[`GOOGLE_API_KEY_${i}`]
    const gemini = process.env[`GEMINI_API_KEY_${i}`]
    if (google) indexed.push(google)
    else if (gemini) indexed.push(gemini)
  }

  return indexed.length ? indexed : [process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ""].filter(Boolean)
}

function nextKey(keys: string[]) {
  const now = Date.now()
  return keys.find(k => (keyCooldown.get(k) ?? 0) <= now) ?? null
}

async function geminiGenerate(prompt: string): Promise<string> {
  const keys = apiKeys()
  if (!keys.length) throw new Error("GOOGLE_API_KEY/GEMINI_API_KEY nao configurada")

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  })

  let lastError: Error | null = null
  for (let attempt = 0; attempt < keys.length + 3; attempt++) {
    const key = nextKey(keys)
    if (!key) break

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body })

    if (res.ok) {
      const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    }

    const errText = await res.text().catch(() => "")
    lastError = new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`)

    if (res.status === 429) {
      keyCooldown.set(key, Date.now() + KEY_COOLDOWN_MS)
      continue
    }

    if ([500, 502, 503].includes(res.status)) {
      await new Promise(r => setTimeout(r, 3_000))
      continue
    }

    throw lastError
  }

  throw lastError ?? new Error("Gemini indisponivel")
}

// ─── Benchmarks (mesmos dados do !analisar do bot) ────────────────────────────

const ELO_BENCHMARKS: Record<string, { cspm: number; kda: number; deaths: number; kp: number; vision: number }> = {
  IRON:        { cspm: 3.5, kda: 3.12, deaths: 6.91, kp: 38, vision: 1.22 },
  BRONZE:      { cspm: 4.5, kda: 3.12, deaths: 6.99, kp: 42, vision: 1.35 },
  SILVER:      { cspm: 5.5, kda: 3.18, deaths: 6.78, kp: 47, vision: 1.48 },
  GOLD:        { cspm: 6.2, kda: 3.13, deaths: 6.92, kp: 52, vision: 1.53 },
  PLATINUM:    { cspm: 6.8, kda: 3.16, deaths: 6.82, kp: 56, vision: 1.59 },
  EMERALD:     { cspm: 7.2, kda: 3.21, deaths: 6.67, kp: 59, vision: 1.62 },
  DIAMOND:     { cspm: 7.7, kda: 3.29, deaths: 6.46, kp: 62, vision: 1.67 },
  MASTER:      { cspm: 8.2, kda: 3.43, deaths: 6.09, kp: 65, vision: 1.77 },
  GRANDMASTER: { cspm: 8.5, kda: 3.48, deaths: 6.00, kp: 67, vision: 1.80 },
  CHALLENGER:  { cspm: 8.8, kda: 3.54, deaths: 5.88, kp: 69, vision: 1.80 },
}

const ROLE_MULTIPLIERS: Record<string, { cspm: number; kda: number; deaths: number; kp: number; vision: number }> = {
  TOP:     { cspm: 0.97, kda: 0.79, deaths: 0.98, kp: 0.85, vision: 0.75 },
  JUNGLE:  { cspm: 0.80, kda: 1.15, deaths: 0.96, kp: 1.12, vision: 1.05 },
  MIDDLE:  { cspm: 1.02, kda: 0.96, deaths: 0.98, kp: 0.97, vision: 0.90 },
  BOTTOM:  { cspm: 1.10, kda: 0.96, deaths: 1.06, kp: 0.90, vision: 0.68 },
  UTILITY: { cspm: 0.12, kda: 1.14, deaths: 1.02, kp: 1.08, vision: 1.50 },
}

const ROLE_PT: Record<string, string> = {
  TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "ADC", UTILITY: "Suporte",
  MID: "Mid", BOT: "ADC", SUPPORT: "Suporte",
}

function toRoleKey(pos: string | undefined): string {
  const p = (pos ?? "").toUpperCase()
  if (p === "MID") return "MIDDLE"
  if (p === "BOT") return "BOTTOM"
  if (p === "SUPPORT") return "UTILITY"
  return p
}

function getBenchmark(tier: string | undefined, roleKey: string) {
  const base = ELO_BENCHMARKS[tier?.toUpperCase() ?? ""] ?? ELO_BENCHMARKS["SILVER"]
  const m = ROLE_MULTIPLIERS[roleKey]
  if (!m) return { cspm: base.cspm, kda: base.kda, deaths: base.deaths, kp: base.kp, vision: base.vision }
  return {
    cspm:   Math.round(base.cspm   * m.cspm   * 10) / 10,
    kda:    Math.round(base.kda    * m.kda    * 100) / 100,
    deaths: Math.round(base.deaths * m.deaths * 10) / 10,
    kp:     Math.round(base.kp     * m.kp),
    vision: Math.round(base.vision * m.vision * 100) / 100,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function n(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function fmtDuration(seconds: unknown) {
  const total = Math.max(0, Math.floor(n(seconds)))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function fmtTime(sec: unknown) {
  const s = Math.floor(n(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? v as T[] : []
}

// ─── Snapshot formatters ──────────────────────────────────────────────────────

function extractTier(loading: Record<string, unknown> | null | undefined): string | undefined {
  const myTeam = asList<Record<string, unknown>>(loading?.myTeam)
  const me = myTeam.find(p => p.isMe)
  const tier = String((me?.elo as Record<string, unknown>)?.tier ?? "")
  return tier && tier !== "UNRANKED" ? tier : undefined
}

function fmtPlayer(p: Record<string, unknown>) {
  const name      = String(p.summonerName ?? p.championName ?? "?").split("#")[0]
  const champ     = String(p.championName ?? "")
  const kda       = `${n(p.kills)}/${n(p.deaths)}/${n(p.assists)}`
  const cs        = n(p.cs) > 0 ? ` · ${n(p.cs)}cs` : ""
  const gold      = n(p.netWorth) > 0 ? ` · ${(n(p.netWorth) / 1000).toFixed(1)}k` : ""
  const vision    = n(p.wardScore) > 0 ? ` · ${n(p.wardScore)}vs` : ""
  return `  ${champ} (${name}): ${kda}${cs}${gold}${vision}`
}

function buildScoreboardSection(scoreboard: Record<string, unknown> | null | undefined): string {
  const players = asList<Record<string, unknown>>(scoreboard?.players)
  if (!players.length) return ""

  const order = players.filter(p => String(p.team).toUpperCase() === "ORDER")
  const chaos = players.filter(p => String(p.team).toUpperCase() === "CHAOS")

  const lines: string[] = []
  if (order.length) {
    lines.push("TIME ORDER:")
    order.forEach(p => lines.push(fmtPlayer(p)))
  }
  if (chaos.length) {
    lines.push("TIME CHAOS:")
    chaos.forEach(p => lines.push(fmtPlayer(p)))
  }
  return lines.join("\n")
}

function buildEventsSection(
  events: EndGameSnapshot["events"],
  myName: string,
): string {
  if (!events?.length) return "Sem eventos registrados."

  const lines: string[] = []
  let myKills = 0, myDeaths = 0, myAssists = 0

  const kills = events.filter(e => e.event_type === "kill")
  const objectives = events.filter(e => e.event_type === "objective")
  const multikills = events.filter(e => e.event_type === "multikill")

  for (const e of kills.slice(0, 25)) {
    const d = e.data
    const t = fmtTime(d.eventTime)
    if (d.isMeKilling) {
      myKills++
      const v = String(d.victim ?? "?").split("#")[0]
      const a = asList<string>(d.assisters).map(s => s.split("#")[0]).join(", ")
      lines.push(`  [${t}] Kill: ${v}${a ? ` (assist: ${a})` : ""}`)
    } else if (d.isMeDying) {
      myDeaths++
      const k = String(d.killer ?? "?").split("#")[0]
      lines.push(`  [${t}] Morte: por ${k}`)
    } else if (d.isMeAssisting) {
      myAssists++
    }
  }

  for (const e of multikills) {
    const d = e.data
    lines.push(`  [${fmtTime(d.eventTime)}] ${d.label ?? "Multikill"} ✅`)
  }

  const objLines: string[] = []
  for (const e of objectives.slice(0, 20)) {
    const d = e.data
    const t = fmtTime(d.eventTime)
    const type = String(d.type ?? "")
    const killer = String(d.killer ?? "?").split("#")[0]
    const stolen = d.stolen ? " (ROUBADO)" : ""
    if (type === "dragon") {
      objLines.push(`  [${t}] Dragão ${d.dragonType ?? ""}${stolen} — ${killer}`)
    } else if (type === "baron") {
      objLines.push(`  [${t}] Baron${stolen} — ${killer}`)
    } else if (type === "herald") {
      objLines.push(`  [${t}] Herald${stolen} — ${killer}`)
    } else if (type === "tower") {
      objLines.push(`  [${t}] Torre — ${killer}`)
    } else if (type === "inhibitor") {
      objLines.push(`  [${t}] Inibidor — ${killer}`)
    } else if (type === "void_grub") {
      objLines.push(`  [${t}] Void Grub${stolen} — ${killer}`)
    } else if (type === "atakhan") {
      objLines.push(`  [${t}] Atakhan${stolen} — ${killer}`)
    }
  }

  const out: string[] = []
  if (lines.length) {
    out.push(`Participação direta (${myKills} kills · ${myDeaths} mortes · ${myAssists} assists via evento):`)
    out.push(...lines)
  }
  if (objLines.length) {
    out.push("Objetivos:")
    out.push(...objLines)
  }

  return out.length ? out.join("\n") : "Sem eventos relevantes."
}

function buildLoadingContext(loading: Record<string, unknown> | null | undefined, myName: string): string {
  if (!loading) return ""

  const myTeam   = asList<Record<string, unknown>>(loading.myTeam)
  const enemy    = asList<Record<string, unknown>>(loading.enemyTeam)

  const fmtTeamLine = (p: Record<string, unknown>) => {
    const name  = String(p.summonerName ?? "?").split("#")[0]
    const champ = p.championName ? String(p.championName) : ""
    const elo   = (p.elo as Record<string, unknown>)
    const eloLbl = elo ? `${elo.tier} ${elo.division} ${elo.lp}LP (${elo.totalGames}j · ${elo.reliableWinRate ? elo.winRate + "%WR" : "WR ind."})` : ""
    const pills: string[] = []
    if (p.autofill) pills.push(`autofill ${p.selectedPosition}→${p.assignedPosition}`)
    if (p.newChampion) pills.push("novo champ")
    if (p.streak) {
      const s = p.streak as { type: string; count: number }
      pills.push(`${s.count}${s.type === "win" ? "W" : "L"} streak`)
    }
    const pos   = String(p.assignedPosition ?? "")
    return `  ${pos ? pos + " · " : ""}${champ ? champ + " · " : ""}${name}: ${eloLbl}${pills.length ? " [" + pills.join(", ") + "]" : ""}`
  }

  const lines: string[] = []
  if (myTeam.length) {
    lines.push("ALIADOS:")
    myTeam.forEach(p => lines.push(fmtTeamLine(p)))
  }
  if (enemy.length) {
    lines.push("INIMIGOS:")
    enemy.forEach(p => lines.push(fmtTeamLine(p)))
  }
  return lines.join("\n")
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(snapshot: EndGameSnapshot): string {
  const me        = snapshot.me ?? {}
  const kills     = n(me.kills)
  const deaths    = n(me.deaths)
  const assists   = n(me.assists)
  const cs        = n(me.cs)
  const duration  = n(snapshot.duration ?? me.gameTime)
  const cspm      = duration > 0 ? (cs / duration * 60).toFixed(1) : String(n(me.cspm))
  const kdaRatio  = deaths === 0 ? kills + assists : ((kills + assists) / deaths)
  const kp        = n(me.killParticipation)
  const wardScore = n(me.wardScore)
  const level     = n(me.level)
  const netWorth  = n(me.netWorth)

  const name      = snapshot.summonerName || String(me.summonerName ?? "Jogador")
  const champion  = snapshot.championName || String(me.championName ?? "?")
  const pos       = snapshot.position || String(me.position ?? me.assignedPosition ?? "")
  const roleKey   = toRoleKey(pos)
  const rolePt    = ROLE_PT[pos.toUpperCase()] ?? ROLE_PT[roleKey] ?? (pos || "?")
  const isSupport = roleKey === "UTILITY"
  const result    = snapshot.result
  const resultStr = result
    ? (String(result).toLowerCase().includes("win") || String(result).toLowerCase().includes("vit") ? "🟢 VITÓRIA" : "🔴 DERROTA")
    : "RESULTADO DESCONHECIDO"

  const tier       = extractTier(snapshot.loading)
  const eloLabel   = tier ?? "Silver"
  const bench      = getBenchmark(tier, roleKey)
  const visionPm   = duration > 0 && wardScore > 0 ? (wardScore / (duration / 60)).toFixed(2) : null

  const items = asList<Record<string, unknown>>(me.items)
    .filter(i => n(i.price) >= 1000)
    .map(i => String(i.name ?? i.id ?? ""))
    .filter(Boolean)

  const scoreboardSection   = buildScoreboardSection(snapshot.scoreboard)
  const eventsSection       = buildEventsSection(snapshot.events, name)
  const loadingCtx          = buildLoadingContext(snapshot.loading, name)

  return `Coach de LoL analisando uma única partida de ${name} (${eloLabel} · ${rolePt}).
Retorne SOMENTE JSON válido:
{"resumo":"str","foi_bem":["str","str"],"errou":["str","str"],"dica":"str","nota":7.5}

PARTIDA:
Resultado: ${resultStr} · ${champion} (${rolePt}) · ${fmtDuration(duration)}
KDA: ${kills}/${deaths}/${assists} (ratio ${kdaRatio.toFixed(2)})${!isSupport ? ` | CS: ${cs} (${cspm}/min)` : ""}
KP: ${kp}%${visionPm ? ` | Vision Score: ${wardScore} (${visionPm}/min)` : ""} | Level: ${level}${netWorth > 0 ? ` | NetWorth: ${(netWorth / 1000).toFixed(1)}k` : ""}
${items.length ? "Itens: " + items.join(", ") : ""}

BENCHMARK ${eloLabel} · ${rolePt} (referência média da posição):
${!isSupport ? `CS/min ref: ${bench.cspm} | ` : ""}KDA ref: ${bench.kda} | Mortes ref: ${bench.deaths} | KP ref: ${bench.kp}% | Vision/min ref: ${bench.vision}

SCOREBOARD FINAL:
${scoreboardSection || "Sem dados de scoreboard."}

EVENTOS:
${eventsSection}

CONTEXTO DE LOADING (elos da partida):
${loadingCtx || "Sem dados de loading."}

REGRAS:
- resumo: 1 frase narrativa específica sobre esse jogo com número real
- foi_bem: 2 bullets curtos com número real quando houver dado disponível
- errou: 2 bullets com ironia/farpa leve (ex: "${deaths} mortes... serviu de ônibus gratuito")
- dica: 1 conselho prático direto para o próximo jogo baseado nos dados acima
- nota: número de 0 a 10 relativo à posição ${rolePt} — 6 é mediano, abaixo de 5 é ruim, acima de 8 é excelente. Use os benchmarks como referência.
- Português brasileiro. APENAS o JSON.`
}

// ─── Extraction & fallback ────────────────────────────────────────────────────

function extractJson(raw: string): PostGameAnalysis {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("Gemini nao retornou JSON")
  const parsed = JSON.parse(match[0]) as Partial<PostGameAnalysis>
  return {
    resumo: String(parsed.resumo || ""),
    foi_bem: Array.isArray(parsed.foi_bem) ? parsed.foi_bem.map(String).slice(0, 3) : [],
    errou:   Array.isArray(parsed.errou)   ? parsed.errou.map(String).slice(0, 3)   : [],
    dica:    String(parsed.dica || ""),
    nota:    typeof parsed.nota === "number" || typeof parsed.nota === "string" ? parsed.nota : "?",
  }
}

function fallbackAnalysis(snapshot: EndGameSnapshot, reason: string): PostGameAnalysis {
  const me       = snapshot.me ?? {}
  const kills    = n(me.kills)
  const deaths   = n(me.deaths)
  const assists  = n(me.assists)
  const cs       = n(me.cs)
  const duration = n(snapshot.duration ?? me.gameTime)
  const cspm     = duration > 0 ? (cs / duration * 60).toFixed(1) : "?"
  const champion = snapshot.championName || String(me.championName ?? "seu campeao")

  return {
    resumo: `Analise automatica indisponivel (${reason}); resumo basico: ${champion} terminou ${kills}/${deaths}/${assists}, ${cs} CS (${cspm}/min).`,
    foi_bem: [
      `Participacao direta registrada no KDA: ${kills}/${deaths}/${assists}.`,
      `Farm final registrado: ${cs} CS em ${fmtDuration(duration)}.`,
    ],
    errou: [
      deaths > 0 ? `Morreu ${deaths}x; vale revisar as quedas antes de objetivo.` : "Sem mortes registradas no snapshot final.",
      "Gemini nao devolveu JSON valido, entao nao vou inventar leitura fina da partida.",
    ],
    dica: "Reveja os minutos das mortes e dos objetivos para achar o ponto em que a partida virou.",
    nota: "?",
    fallbackReason: reason,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generatePostGameAnalysis(snapshot: EndGameSnapshot): Promise<PostGameAnalysis> {
  const raw = await geminiGenerate(buildPrompt(snapshot))
  try {
    return { ...extractJson(raw), rawText: raw }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...fallbackAnalysis(snapshot, reason), rawText: raw }
  }
}

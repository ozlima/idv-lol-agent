const MODEL = "gemini-2.5-flash"
const KEY_COOLDOWN_MS = 65_000

const keyCooldown = new Map<string, number>()

export type PostGameAnalysis = {
  resumo: string
  foi_bem: string[]
  errou: string[]
  dica: string
  nota: number | string
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
    generationConfig: { temperature: 0.65, maxOutputTokens: 2048 },
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

function n(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function fmtDuration(seconds: unknown) {
  const total = Math.max(0, Math.floor(n(seconds)))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function jsonLines(value: unknown, max = 4_000) {
  return JSON.stringify(value ?? null, null, 2).slice(0, max)
}

function extractJson(raw: string): PostGameAnalysis {
  const cleaned = raw.replace(/```(?:json)?\s*|\s*```/g, "").trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("Gemini nao retornou JSON")
  const parsed = JSON.parse(match[0]) as Partial<PostGameAnalysis>
  return {
    resumo: String(parsed.resumo || ""),
    foi_bem: Array.isArray(parsed.foi_bem) ? parsed.foi_bem.map(String).slice(0, 3) : [],
    errou: Array.isArray(parsed.errou) ? parsed.errou.map(String).slice(0, 3) : [],
    dica: String(parsed.dica || ""),
    nota: typeof parsed.nota === "number" || typeof parsed.nota === "string" ? parsed.nota : "?",
  }
}

function buildPrompt(snapshot: EndGameSnapshot) {
  const me = snapshot.me ?? {}
  const kills = n(me.kills)
  const deaths = n(me.deaths)
  const assists = n(me.assists)
  const cs = n(me.cs)
  const duration = n(snapshot.duration ?? me.gameTime)
  const cspm = duration > 0 ? (cs / duration * 60).toFixed(1) : "?"
  const kdaRatio = deaths === 0 ? kills + assists : ((kills + assists) / deaths).toFixed(2)
  const events = (snapshot.events ?? []).slice(0, 45).map(e => ({ type: e.event_type, data: e.data, at: e.created_at }))

  return `Coach de League of Legends analisando uma unica partida ao vivo finalizada.
Retorne SOMENTE JSON valido:
{"resumo":"str","foi_bem":["str","str"],"errou":["str","str"],"dica":"str","nota":7.5}

PARTIDA:
Jogador: ${snapshot.summonerName || me.summonerName || "?"}
Campeao: ${snapshot.championName || me.championName || "?"}
Posicao: ${snapshot.position || me.position || "?"}
Resultado: ${snapshot.result || "desconhecido"}
Duracao: ${fmtDuration(duration)}
KDA: ${kills}/${deaths}/${assists} (ratio ${kdaRatio})
CS: ${cs} (${cspm}/min)
Nivel: ${me.level ?? "?"}
Gold/netWorth: ${me.netWorth ?? "?"}

PLACAR/TIMES:
Score: ${jsonLines(snapshot.score, 900)}
CS times: ${jsonLines(snapshot.teamCS, 900)}
Gold times: ${jsonLines(snapshot.teamGold, 900)}

LOADING ANALYSIS:
${jsonLines(snapshot.loading, 3_000)}

SCOREBOARD FINAL OU ULTIMO SNAPSHOT:
${jsonLines(snapshot.scoreboard, 4_000)}

EVENTOS RELEVANTES DO JOGO:
${jsonLines(events, 4_000)}

REGRAS:
- resumo: 1 frase narrativa especifica sobre esse jogo.
- foi_bem: 2 bullets curtos com numero real quando existir dado.
- errou: 2 bullets curtos com ironia/farpa leve, mas sem inventar dado ausente.
- dica: 1 conselho pratico direto para o proximo jogo.
- nota: numero de 0 a 10, decimal permitido.
- Se o resultado nao estiver explicito, analise desempenho e contexto sem cravar vitoria/derrota.
- Portugues brasileiro. APENAS o JSON.`
}

export async function generatePostGameAnalysis(snapshot: EndGameSnapshot): Promise<PostGameAnalysis> {
  return extractJson(await geminiGenerate(buildPrompt(snapshot)))
}

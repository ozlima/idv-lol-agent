import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
)

export type EventType =
  | "champ_hover"
  | "champ_select_state"
  | "champ_select_complete"
  | "loading_analysis"
  | "game_start"
  | "game_update"
  | "game_end"
  | "scoreboard"
  | "kill"
  | "multikill"
  | "first_blood"
  | "objective"
  | "raw_lol_event"
  | "gameflow_phase"

export async function publishEvent(
  puuid: string,
  eventType: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("live_game_events")
    .insert({ puuid, event_type: eventType, data })

  if (error) console.error(`[publisher] Erro ao publicar ${eventType}:`, error.message)
  else console.log(`[publisher] ✓ ${eventType}`)
}

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
)

const channel = supabase.channel("idv-agent-admin")

channel.subscribe((status) => {
  if (status !== "SUBSCRIBED") return

  channel
    .send({ type: "broadcast", event: "update", payload: { at: new Date().toISOString() } })
    .then(() => {
      console.log("✓ Comando de update enviado para todos os agents online")
      setTimeout(() => process.exit(0), 500)
    })
    .catch((e: unknown) => {
      console.error("✗ Erro ao enviar update:", e)
      process.exit(1)
    })
})

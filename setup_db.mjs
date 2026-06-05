import pg from 'pg'
const { Client } = pg

const client = new Client({
  connectionString: 'postgresql://postgres:%23Muceguinha10%40@db.tninlfmhruccphpncahs.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false },
})
await client.connect()

await client.query(`
  CREATE TABLE IF NOT EXISTS live_game_events (
    id          BIGSERIAL PRIMARY KEY,
    puuid       TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)

await client.query(`CREATE INDEX IF NOT EXISTS live_game_events_puuid_idx ON live_game_events(puuid)`)
await client.query(`CREATE INDEX IF NOT EXISTS live_game_events_created_at_idx ON live_game_events(created_at)`)

// Habilita Realtime na tabela
await client.query(`ALTER TABLE live_game_events REPLICA IDENTITY FULL`)

console.log('✓ Tabela live_game_events criada')

// Limpa eventos com mais de 4 horas automaticamente (função + cron no Supabase)
// Por enquanto faz limpeza manual na inicialização
await client.query(`
  DELETE FROM live_game_events WHERE created_at < NOW() - INTERVAL '4 hours'
`)
console.log('✓ Eventos antigos removidos')

await client.end()

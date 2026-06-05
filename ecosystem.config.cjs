const fs   = require("fs")
const path = require("path")

function parseEnv(file) {
  try {
    return Object.fromEntries(
      fs.readFileSync(file, "utf8")
        .split("\n")
        .filter(l => l.includes("=") && !l.startsWith("#") && l.trim())
        .map(l => {
          const idx = l.indexOf("=")
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
        })
    )
  } catch { return {} }
}

module.exports = {
  apps: [
    {
      name:             "idv-lol-agent",
      script:           "src/index.ts",
      interpreter:      "node",
      interpreter_args: "--import tsx",
      cwd:              __dirname,
      watch:            false,
      autorestart:      true,
      restart_delay:    5000,
      max_restarts:     20,
      min_uptime:       "5s",
      env: {
        NODE_ENV: "production",
        ...parseEnv(path.join(__dirname, ".env")),
      },
    },
  ],
}

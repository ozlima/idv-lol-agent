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

// tsx.cmd é o executável correto para PM2 no Windows
const tsxBin = path.join(__dirname, "node_modules", ".bin", "tsx.cmd")

module.exports = {
  apps: [
    {
      name:          "idv-lol-agent",
      script:        tsxBin,
      args:          "src/index.ts",
      cwd:           __dirname,
      interpreter:   "none",
      watch:         false,
      autorestart:   true,
      restart_delay: 5000,
      max_restarts:  20,
      min_uptime:    "5s",
      env: {
        NODE_ENV: "production",
        ...parseEnv(path.join(__dirname, ".env")),
      },
    },
  ],
}

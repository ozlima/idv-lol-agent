module.exports = {
  apps: [
    {
      name: "idv-lol-agent",
      script: "npm",
      args: "run dev",
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 5,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
}

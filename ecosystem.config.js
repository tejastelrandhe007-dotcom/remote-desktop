module.exports = {
  apps: [
    {
      name: "remote-desktop",
      script: "./server.js",
      cwd: "/var/www/remote-desktop",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true
    }
  ]
};

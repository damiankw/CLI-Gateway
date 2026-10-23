// pm2 process config for cli-gateway.
//   pm2 start ecosystem.config.js    # start
//   pm2 logs cli-gateway             # tail logs
//   pm2 restart cli-gateway          # restart (e.g. after editing config.json)
//   pm2 save && pm2 startup          # persist across reboots
module.exports = {
  apps: [
    {
      name: 'cli-gateway',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // config.json already sets host/port; override here or add secrets via env if you like:
      env: {
        // GATEWAY_PORT: '4000',
        // GATEWAY_KEY: 'your-gateway-key',
      },
    },
  ],
};

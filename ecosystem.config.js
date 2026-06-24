// PM2 process definitions. Build first (`npm run build`), then `pm2 start ecosystem.config.js`.
module.exports = {
  apps: [
    {
      // The fleet manager. Running bots already self-reconcile every 6h, and each bot
      // runs a final reconciliation the moment it is stopped from the dashboard.
      name: 'blacklane-bot',
      script: 'dist/index.js',
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      // Month-end safety sweep: reconciles EVERY bot (including stopped ones) and covers
      // any window where the bot process was down. Runs at 00:05 on the 1st of each month,
      // which captures everything completed in the previous month.
      // One-shot: the script exits when done; pm2 re-launches it at the next cron tick.
      name: 'reconcile-monthly',
      script: 'dist/jobs/reconcile-billing.js',
      autorestart: false,
      cron_restart: '5 0 1 * *',
    },
  ],
};

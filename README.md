{
  "name": "ledger-discord",
  "version": "1.0.0",
  "description": "Ledger notes app with Discord login, self-hosted",
  "type": "commonjs",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "dotenv": "^16.4.5"
  }
}

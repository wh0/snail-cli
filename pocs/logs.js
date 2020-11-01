const WebSocket = require('ws');

const ws = new WebSocket(`wss://api.glitch.com/${process.env.G_PROJECT_ID}/logs?authorization=${process.env.G_PERSISTENT_TOKEN}`);
ws.on('message', (data) => {
  console.log(data);
});

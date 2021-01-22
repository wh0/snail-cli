const io = require('socket.io-client');

const socket = io('https://api.glitch.com', {
  path: `/${process.env.G_PROJECT_DOMAIN}/console/${process.env.G_PERSISTENT_TOKEN}/socket.io`,
});

function handleResize() {
  socket.emit('resize', {
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  });
}

socket.on('disconnect', (reason) => {
  console.error('Socket disconnected: ' + reason);
  process.exit(1);
});
socket.on('error', (e) => {
  console.error(e);
});
socket.on('login', () => {
  process.stdin.setRawMode(true);
  handleResize();
});
socket.on('logout', () => {
  process.exit(0);
});
socket.on('data', (data) => {
  process.stdout.write(data);
});

process.stdout.on('resize', handleResize);
process.stdin.on('data', (data) => {
  socket.emit('input', data);
});

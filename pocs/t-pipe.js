const fs = require('fs');
const stream = require('stream');
const util = require('util');

const io = require('socket.io-client');

function shellWord(s) {
  return '\'' + s.replace(/'/g, '\'"\'"\'') + '\'';
}

const WRAPPER_SRC = fs.readFileSync('pocs/t-pipe-wrap.js', {encoding: 'utf8'});

let stdinStarted = false;
let stdoutEnded = false;
let stderrEnded = false;
let returned = false;
let recvBuf = '';

const socket = io('https://api.glitch.com', {
  path: `/${process.env.G_PROJECT_DOMAIN}/console/${process.env.G_PERSISTENT_TOKEN}/socket.io`,
});

socket.on('disconnect', () => {
  if (!returned) {
    throw new Error('Socket disconnected');
  }
});
socket.on('error', (e) => {
  console.error(e);
});
socket.on('data', (data) => {
  const parts = (recvBuf + data).split('\n');
  recvBuf = parts.pop();
  for (const part of parts) {
    switch (part[0]) {
      case 's':
        if (stdinStarted) break;
        stdinStarted = true;
        process.stdin.on('data', (chunk) => {
          socket.emit('input', chunk.toString('base64') + '\n');
        });
        process.stdin.on('end', () => {
          socket.emit('input', '\n');
        });
        break;
      case 'p':
        break;
      case 'o':
        if (stdoutEnded) break;
        process.stdout.write(Buffer.from(part.slice(1), 'base64'));
        break;
      case 'O':
        if (stdoutEnded) break;
        stdoutEnded = true;
        process.stdout.end();
        break;
      case 'e':
        if (stderrEnded) break;
        process.stderr.write(Buffer.from(part.slice(1), 'base64'));
        break;
      case 'E':
        if (stderrEnded) break;
        stderrEnded = true;
        process.stderr.end();
        break;
      case 'r':
        if (returned) break;
        returned = true;
        process.exit(+part.slice(1));
        break;
      default: // %%%
        console.error(part);
    }
  }
});
socket.once('login', () => {
  socket.emit('input', 'unset HISTFILE && exec /opt/nvm/versions/node/v10/bin/node -e ' + shellWord(WRAPPER_SRC) + ' ' + shellWord(process.argv[2]) + '\n');
});

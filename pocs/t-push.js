const fs = require('fs');
const stream = require('stream');
const util = require('util');

const io = require('socket.io-client');

const socket = io('https://api.glitch.com', {
  path: `/${process.env.G_PROJECT_DOMAIN}/console/${process.env.G_PERSISTENT_TOKEN}/socket.io`,
});

socket.on('disconnect', () => {
  console.log('Socket disconnected');
  process.exit(1);
});
socket.on('error', (e) => {
  console.error(e);
});
socket.on('login', () => {
  console.log('%%% login');
});
socket.on('logout', () => {
  console.log('%%% logout');
  process.exit(0);
});
socket.on('data', (data) => {
  process.stdout.write(data);
});

const CHUNK_SIZE = 1024 * 1024;
const MAX_CHUNKS_OUTSTANDING = 4;
const src = fs.createReadStream('/opt/swift/usr/bin/clang-7', {
  highWaterMark: CHUNK_SIZE,
});
let total = 0;
let numChunksOutstanding = 0;
let needResume = false;
function handleLine(line) {
  switch (line) {
    case 'snail_start\n':
      console.log('%%% < start');
      src.on('data', (chunk) => {
        total += chunk.length;
        socket.emit('input', chunk.toString('base64') + '\n');
        numChunksOutstanding++;
        console.log('%%% > ' + chunk.length + ' ' + total + ' outstanding ' + numChunksOutstanding);
        if (!needResume && numChunksOutstanding >= MAX_CHUNKS_OUTSTANDING) {
          console.log('%%% > pause');
          needResume = true;
          src.pause();
        }
      });
      src.on('end', () => {
        socket.emit('input', '\n');
      });
      break;
    case '.\n':
      numChunksOutstanding--;
      console.log('%%% < outstanding ' + numChunksOutstanding);
      if (needResume && numChunksOutstanding < MAX_CHUNKS_OUTSTANDING) {
        console.log('%%% > resume');
        needResume = false;
        src.resume();
      }
      break;
    case 'snail_end\n':
      console.log('%%% < end');
      break;
  }
}

let readBuf = '';
function handleData(data) {
  readBuf += data;
  while (true) {
    const nlIdx = readBuf.indexOf('\n');
    if (nlIdx === -1) break;
    const line = readBuf.slice(0, nlIdx + 1);
    handleLine(line);
    readBuf = readBuf.slice(nlIdx + 1);
  }
}
socket.on('data', handleData);

function emitRemoteReceiver() {
  socket.emit('input', `stty raw -echo; exec python3 -c '
import base64
import sys

with open(3, "wb") as dst:
  print("snail_start")
  for line in sys.stdin:
    if line == "\\n":
      break
    print(".")
    chunk = base64.b64decode(line)
    dst.write(chunk)
  print("snail_end")
' 3>/tmp/clang-7
`);
}
socket.once('login', emitRemoteReceiver);

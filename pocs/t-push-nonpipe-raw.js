const fs = require('fs');
const stream = require('stream');
const util = require('util');

const io = require('socket.io-client');

const socket = io('https://api.glitch.com', {
  path: `/${process.env.G_PROJECT_DOMAIN}/console/${process.env.G_PERSISTENT_TOKEN}/socket.io`,
});

socket.on('disconnect', () => {
  console.error('Socket disconnected');
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

// process.stdin.on('data', (data) => {
//   socket.emit('input', data);
// });

(async function () {
  try {
    const stat = await fs.promises.stat('/opt/swift/usr/bin/clang-7');
    const chunkSize = 1024 * 1024;
    let total = 0;
    await new Promise((resolve, reject) => {
      setTimeout(resolve, 3000);
    });
    socket.emit('input', `stty raw -echo; exec python3 -c '
import sys

with open(3, "wb") as dst:
  print("snail_start")
  for line in sys.stdin.buffer:
    chunk_size = int(line)
    if chunk_size == 0:
      break
    print(".")
    chunk = sys.stdin.buffer.read(chunk_size)
    dst.write(chunk)
  print("snail_end")
' 3>/dev/null
`);
    await new Promise((resolve, reject) => {
      setTimeout(resolve, 1000);
    });
    const src = fs.createReadStream('/opt/swift/usr/bin/clang-7', {
      highWaterMark: chunkSize,
    });
    src.on('data', (chunk) => {
      total += chunk.length;
      console.log('%%% > ' + chunk.length + ' ' + total + '/' + stat.size);
      socket.emit('input', chunk.length + '\n');
      socket.emit('input', chunk);
    });
    src.on('end', () => {
      socket.emit('input', '0\n');
    });
  } catch (e) {
    console.error(e);
  }
})();

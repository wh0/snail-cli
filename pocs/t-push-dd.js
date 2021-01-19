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
    // let total = 0;
    const dst = new stream.Writable({
      highWaterMark: 1024 * 1024,
      write: (chunk, encoding, callback) => {
        // total += chunk.length;
        // console.log('%%% > ' + chunk.length + ' ' + total + '/' + stat.size);
        socket.emit('input', chunk);
        callback();
      },
    });
    await new Promise((resolve, reject) => {
      setTimeout(resolve, 3000);
    });
    socket.emit('input', 'stty -echo raw && exec dd bs=4K iflag=fullblock,count_bytes count=' + stat.size + ' status=progress >/tmp/clang-7\n');
    await new Promise((resolve, reject) => {
      setTimeout(resolve, 1000);
    });
    const src = await fs.createReadStream('/opt/swift/usr/bin/clang-7', {
      highWaterMark: 1024 * 1024,
    });
    await util.promisify(stream.pipeline)(src, dst);
  } catch (e) {
    console.error(e);
  }
})();

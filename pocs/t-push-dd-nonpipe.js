const fs = require('fs');
const stream = require('stream');
const util = require('util');

const io = require('socket.io-client');

(async function () {
  try {
    const stat = await fs.promises.stat('/opt/swift/usr/bin/clang-7');

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

    let recvBuf = '';
    function watchRemote(data) {
      recvBuf += data;
      if (recvBuf.includes('snail_start\n')) {
        socket.off('data', watchRemote);
        const src = fs.createReadStream('/opt/swift/usr/bin/clang-7', {
          highWaterMark: 1024 * 1024,
        });
        src.on('data', (chunk) => {
          socket.emit('input', chunk);
        });
      }
    }
    socket.on('data', watchRemote);

    socket.once('login', () => {
      socket.emit('input', 'stty -echo raw && echo snail_start && exec dd bs=4K iflag=fullblock,count_bytes count=' + stat.size + ' status=progress >/tmp/clang-7\n');
    });
  } catch (e) {
    console.error(e);
  }
})();

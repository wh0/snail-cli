const childProcess = require('child_process');

process.stdin.setRawMode(true);
process.stdout.write('s\n');

setInterval(() => {
  process.stdout.write('p\n');
}, 4000);

const p = childProcess.spawn(process.argv[1], {
  stdio: 'pipe',
  shell: true,
});

let stdinBuf = '';
process.stdin.setEncoding('ascii');
process.stdin.on('data', (chunk) => {
  const parts = (stdinBuf + chunk).split('\n');
  stdinBuf = parts.pop();
  for (const part of parts) {
    if (part) {
      p.stdin.write(Buffer.from(part, 'base64'));
    } else {
      p.stdin.end();
    }
  }
});

p.stdout.on('data', (chunk) => {
  process.stdout.write('o' + chunk.toString('base64') + '\n');
});
p.stdout.on('end', () => {
  process.stdout.write('O\n');
});

p.stderr.on('data', (chunk) => {
  process.stdout.write('e' + chunk.toString('base64') + '\n');
});
p.stderr.on('end', () => {
  process.stdout.write('E\n');
});

p.on('exit', (code, signal) => {
  const rv = signal === null ? code : 1;
  process.stdout.write('r' + rv + '\n');
  process.exit();
});

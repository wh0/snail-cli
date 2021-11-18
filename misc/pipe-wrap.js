// minify this file for `doTPipe`

/* eslint-disable no-var, import/newline-after-import */

var base64 = 'base64';
var data = 'data';

var {
  stdin: processStdin,
  stdout: processStdout,
  argv: [, commandB64],
} = process;

var pingTimer = null;

var writeln = (v) => {
  if (pingTimer) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
  processStdout.write(v + '\n');
};

var child = require('child_process').spawn(Buffer.from(commandB64, base64).toString('utf8'), {
  stdio: 'pipe',
  shell: true,
});

var recvBuf = '';

processStdin.setRawMode(true);
processStdin.setEncoding('ascii');
processStdin.on(data, (chunk) => {
  if (!pingTimer) {
    pingTimer = setTimeout(() => {
      writeln(')p');
    }, 4000);
  }
  var parts = (recvBuf + chunk).split('\n');
  recvBuf = parts.pop();
  for (var part of parts) {
    if (part) {
      child.stdin.write(Buffer.from(part, base64));
    } else {
      child.stdin.end();
    }
  }
});

writeln(')s');

child.stdout.on(data, (chunk) => {
  writeln(')o' + chunk.toString(base64));
});

child.stderr.on(data, (chunk) => {
  writeln(')e' + chunk.toString(base64));
});

child.on('exit', (code, signal) => {
  var rv = signal ? 1 : code;
  writeln(')r' + rv);
  processStdin.pause();
});

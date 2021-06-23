// minify this file for `doTPipe`

/* eslint-disable no-var, import/newline-after-import */

var base64 = 'base64';
var data = 'data';
var end = 'end';

var {
  stdin: processStdin,
  stdout: processStdout,
  argv: [, command],
} = process;

var pingTimer = null;

var writeln = (v) => {
  if (pingTimer) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
  processStdout.write(v + '\n');
};

var child = require('child_process').spawn(command, {
  stdio: 'pipe',
  shell: true,
});
var {
  stdin: childStdin,
  stdout: childStdout,
  stderr: childStderr,
} = child;

var recvBuf = '';

processStdin.setRawMode(true);
processStdin.setEncoding('ascii');
processStdin.on(data, (chunk) => {
  if (!pingTimer) {
    pingTimer = setTimeout(() => {
      writeln('p');
    }, 4000);
  }
  var parts = (recvBuf + chunk).split('\n');
  recvBuf = parts.pop();
  for (var part of parts) {
    if (part) {
      childStdin.write(Buffer.from(part, base64));
    } else {
      childStdin.end();
    }
  }
});

writeln('s');

childStdout.on(data, (chunk) => {
  writeln('o' + chunk.toString(base64));
});
childStdout.on(end, () => {
  writeln('O');
});

childStderr.on(data, (chunk) => {
  writeln('e' + chunk.toString(base64));
});
childStderr.on(end, () => {
  writeln('E');
});

child.on('exit', (code, signal) => {
  var rv = signal ? 1 : code;
  writeln('r' + rv);
  processStdin.pause();
});

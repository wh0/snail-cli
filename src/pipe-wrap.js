// minify this file for `doTPipe`

/* eslint-disable no-var */

var childProcess = require('child_process');

var base64 = 'base64';
var data = 'data';
var end = 'end';
var nl = '\n';

var processAlias = process;
var {stdin: processStdin, stdout: processStdout} = processAlias;
var processStdoutWrite = processStdout.write.bind(processStdout);

var child = childProcess.spawn(processAlias.argv[1], {
  stdio: 'pipe',
  shell: true,
});
var {stdin: childStdin, stdout: childStdout, stderr: childStderr} = child;

var pingTimer = setInterval(() => {
  processStdoutWrite('p\n');
}, 4000);

var stdinBuf = '';

processStdin.setRawMode(true);
processStdin.setEncoding('ascii');
processStdin.on(data, (chunk) => {
  var parts = (stdinBuf + chunk).split(nl);
  stdinBuf = parts.pop();
  for (var part of parts) {
    if (part) {
      childStdin.write(Buffer.from(part, base64));
    } else {
      childStdin.end();
    }
  }
});

processStdoutWrite('s\n');

childStdout.on(data, (chunk) => {
  processStdoutWrite('o' + chunk.toString(base64) + nl);
});
childStdout.on(end, () => {
  processStdoutWrite('O\n');
});

childStderr.on(data, (chunk) => {
  processStdoutWrite('e' + chunk.toString(base64) + nl);
});
childStderr.on(end, () => {
  processStdoutWrite('E\n');
});

child.on('exit', (code, signal) => {
  var rv = signal ? 1 : code;
  processStdoutWrite('r' + rv + nl);
  clearTimeout(pingTimer);
  processStdin.pause();
});

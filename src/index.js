'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const commander = require('commander');
const fetch = require('node-fetch').default;

const packageMeta = require('../package.json');

// credentials

function getPersistentTokenFromEnv() {
  return process.env.G_PERSISTENT_TOKEN;
}

async function getPersistentTokenFromConfig() {
  return (await fs.promises.readFile(path.join(os.homedir(), '.config', 'snail', 'persistent-token'), 'utf8')).trim();
}

async function getPersistentTokenHowever() {
  return getPersistentTokenFromEnv() || await getPersistentTokenFromConfig();
}

async function getPersistentToken() {
  const persistentToken = await getPersistentTokenHowever();
  if (!persistentToken) throw new Error(`Persistent token unset. Save (${path.join(os.homedir(), '.config', 'snail', 'persistent-token')}) or set in environment (G_PERSISTENT_TOKEN)`);
  return persistentToken;
}

async function boot() {
  const res = await fetch('https://api.glitch.com/boot?latestProjectOnly=true', {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch boot response ${res.status} not ok`);
  return await res.json();
}

// project selection

function getProjectDomainFromOpts(opts) {
  return opts.project;
}

const remoteName = 'glitch';

async function getProjectDomainFromRemote() {
  const {stdout, stderr} = await util.promisify(childProcess.execFile)('git', ['remote', 'get-url', remoteName]);
  const remoteUrl = stdout.trim();
  const m = /https:\/\/(?:[\w-]+@)?api\.glitch\.com\/git\/([\w-]+)/.exec(remoteUrl);
  if (!m) return null;
  return m[1];
}

async function getProjectDomainHowever(opts) {
  return getProjectDomainFromOpts(opts) || await getProjectDomainFromRemote();
}

async function getProjectDomain(opts) {
  const domain = await getProjectDomainHowever(opts);
  if (!domain) throw new Error('Unable to determine which project. Specify (-p) or set up remote (snail remote)');
  return domain;
}

async function getProjectByDomain(domain) {
  const res = await fetch(`https://api.glitch.com/v1/projects/by/domain?domain=${domain}`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects by domain response ${res.status} not ok`);
  const body = await res.json();
  if (!(domain in body)) throw new Error(`Glitch project domain ${domain} not found`);
  return body[domain];
}

// commands

async function doRemote(opts) {
  const projectDomain = getProjectDomainFromOpts(opts);
  if (!projectDomain) throw new Error('Unable to determine which project. Specify (-p)');
  const {user} = await boot();
  const url = `https://${user.gitAccessToken}@api.glitch.com/git/${projectDomain}`;
  await util.promisify(childProcess.execFile)('git', ['remote', 'add', remoteName, url]);
}

async function doSetenv(name, value, opts) {
  const env = {};
  env[name] = value;
  const res = await fetch(`https://api.glitch.com/projects/${await getProjectDomain(opts)}/setenv`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({env}),
  });
  if (!res.ok) throw new Error(`Glitch setenv response ${res.status} not ok`);
}

async function doExec(command, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/projects/${project.id}/exec`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      command: command.join(' '),
    }),
  });
  if (!res.ok) throw new Error(`Glitch exec response ${res.status} not ok`);
  const body = await res.json();
  process.stdout.write(body.stdout);
  process.stderr.write(body.stderr);
}

async function doTerm(opts) {
  const io = require('socket.io-client');

  const socket = io('https://api.glitch.com', {
    path: `/${await getProjectDomain(opts)}/console/${await getPersistentToken()}/socket.io`,
  });

  function handleResize() {
    socket.emit('resize', {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    });
  }

  socket.once('disconnect', (reason) => {
    console.error(`Glitch console disconnected: ${reason}`);
    process.exit(1);
  });
  socket.on('error', (e) => {
    console.error(e);
  });
  socket.once('login', () => {
    if (opts.raw) {
      process.stdin.setRawMode(true);
    }
    handleResize();
    if (opts.c) {
      socket.emit('input', opts.c.join(' ') + '\n');
    }
    process.stdout.on('resize', handleResize);
    process.stdin.on('data', (data) => {
      socket.emit('input', data);
    });
  });
  socket.once('logout', () => {
    process.exit(0);
  });
  socket.on('data', (data) => {
    process.stdout.write(data);
  });
}

async function doTPipe(command, opts) {
  const io = require('socket.io-client');

  function shellWord(s) {
    return '\'' + s.replace(/'/g, '\'"\'"\'') + '\'';
  }

  // see pipe-wrap.js
  const WRAPPER_SRC = 'const s=require("child_process");process.stdin.setRawMode(!0),process.stdout.write("s\\n"),setInterval((()=>{process.stdout.write("p\\n")}),4e3);const t=s.spawn(process.argv[1],{stdio:"pipe",shell:!0});let e="";process.stdin.setEncoding("ascii"),process.stdin.on("data",(s=>{const o=(e+s).split("\\n");e=o.pop();for(const s of o)s?t.stdin.write(Buffer.from(s,"base64")):t.stdin.end()})),t.stdout.on("data",(s=>{process.stdout.write("o"+s.toString("base64")+"\\n")})),t.stdout.on("end",(()=>{process.stdout.write("O\\n")})),t.stderr.on("data",(s=>{process.stdout.write("e"+s.toString("base64")+"\\n")})),t.stderr.on("end",(()=>{process.stdout.write("E\\n")})),t.on("exit",((s,t)=>{const e=null===t?s:1;process.stdout.write("r"+e+"\\n"),process.exit()}));';

  let stdinStarted = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let returned = false;
  let recvBuf = '';

  const socket = io('https://api.glitch.com', {
    path: `/${await getProjectDomain(opts)}/console/${await getPersistentToken()}/socket.io`,
  });

  socket.once('disconnect', (reason) => {
    console.error(`Glitch console disconnected: ${reason}`);
    process.exit(1);
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
        default:
          if (opts.debug) {
            console.error(part);
          }
      }
    }
  });
  socket.once('login', () => {
    socket.emit('input', `unset HISTFILE && exec /opt/nvm/versions/node/v10/bin/node -e ${shellWord(WRAPPER_SRC)} ${shellWord(command.join(' '))}\n`);
  });
}

async function doLogs(opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/logs?authorization=${await getPersistentToken()}`);
  ws.on('open', () => {
    setInterval(() => {
      ws.send('keep alive');
    }, 30000);
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.process === 'application') {
      console.log(msg.text);
    }
  });
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    console.error(`Glitch logs closed: ${code} ${reason}`);
    process.exit(1);
  });
}

async function doStop(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/stop`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch stop response ${res.status} not ok`);
}

async function doAPolicy(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/policy`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch policy response ${res.status} not ok`);
  const body = await res.json();
  console.log(JSON.stringify(body));
}

async function doAPush(source, opts) {
  const FormData = require('form-data');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const policyRes = await fetch(`https://api.glitch.com/v1/projects/${project.id}/policy`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!policyRes.ok) throw new Error(`Glitch policy response ${policyRes.status} not ok`);
  const body = await policyRes.json();
  const policy = JSON.parse(Buffer.from(body.policy, 'base64').toString('utf-8'));
  let bucket, keyPrefix, acl;
  for (const condition of policy.conditions) {
    if (condition instanceof Array) {
      if (condition[1] === '$key' && condition[0] === 'starts-with') keyPrefix = condition[2];
    } else {
      if ('bucket' in condition) bucket = condition.bucket;
      if ('acl' in condition) acl = condition.acl;
    }
  }
  const key = keyPrefix + (opts.name || path.basename(source));
  const form = new FormData();
  form.append('key', key);
  form.append('Content-Type', opts.type);
  form.append('Cache-Control', `max-age=${opts.maxAge}`);
  form.append('AWSAccessKeyId', body.accessKeyId);
  form.append('acl', acl);
  form.append('policy', body.policy);
  form.append('signature', body.signature);
  form.append('file', fs.createReadStream(source));
  // node-fetch is variously annoying about how it sends FormData
  const uploadRes = await util.promisify(form.submit).call(form, `https://s3.amazonaws.com/${bucket}`);
  if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) throw new Error(`S3 upload response ${uploadRes.statusCode} not ok`);
  console.log(`https://cdn.glitch.com/${encodeURIComponent(key)}?v=${Date.now()}`);
}

async function doWebEdit(opts) {
  console.log(`https://glitch.com/edit/#!/${await getProjectDomain(opts)}`);
}

async function doWebTerm(opts) {
  const projectDomain = await getProjectDomain(opts);
  if (opts.cap) {
    console.log(`https://api.glitch.com/${projectDomain}/console/${await getPersistentToken()}/`);
  } else {
    console.log(`https://glitch.com/edit/console.html?${projectDomain}`);
  }
}

async function doWebDebugger(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  if (opts.cap) {
    const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/singlePurposeTokens/devtools`, {
      method: 'POST',
      headers: {
        'Authorization': await getPersistentToken(),
      },
    });
    if (!res.ok) throw new Error(`Glitch single purpose tokens devtools response ${res.status} not ok`);
    const body = await res.json();
    console.log(`devtools://devtools/bundled/inspector.html?ws=api.glitch.com:80/project/debugger/${body.token}`);
  } else {
    console.log(`https://glitch.com/edit/debugger.html?${project.id}`);
  }
}

commander.program.name('snail');
commander.program.version(packageMeta.version);
commander.program
  .command('remote')
  .description('set up the glitch git remote')
  .option('-p, --project <domain>', 'specify which project')
  .action(doRemote);
commander.program
  .command('setenv <name> <value>')
  .description('set an environment variable')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doSetenv);
commander.program
  .command('exec <command...>')
  .description('run a command in the project container')
  .addHelpText('after', `
Limitations:
Command line and output are not binary safe.
No output is returned until the process exits.

Implementation problems:
Output is not printed when command fails.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doExec);
const cmdTerm = commander.program
  .command('term')
  .alias('t')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-c <command...>', 'send initial command')
  .option('--no-raw', 'do not alter stdin tty mode')
  .description('connect to a project terminal')
  .action(doTerm);
cmdTerm
  .command('pipe <command...>')
  .description('run a command and transfer binary data to and from it')
  .addHelpText('after', `
Examples:
    # Download a file
    snail t pipe 'cat .data/omni.db' >omni.db
    # Upload a file
    snail t pipe 'cat >.data/omni.db' <omni.db

Implementation problems:
There is no backpressure, on either side. snail will grow in memory when there
is more data on stdin than the network can send. The WeTTY server will grow in
memory when there is more data on stdout than the network can receive. Restart
the project container with (snail stop) to reclaim memory from WeTTY. Data is
transferred in base64 due to the terminal API supporting UTF-8 only, which is
inefficient.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show unrecognized lines from terminal session')
  .action(doTPipe);
commander.program
  .command('logs')
  .description('watch application logs')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doLogs);
commander.program
  .command('stop')
  .description('stop project container')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doStop);
const cmdAsset = commander.program
  .command('asset')
  .alias('a')
  .description('manage CDN assets');
cmdAsset
  .command('policy')
  .description('provision an S3 POST policy for asset upload')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doAPolicy);
cmdAsset
  .command('push <source>')
  .description('upload an assset')
  .addHelpText('after', `
Implementation problems:
Does not maintain .glitch-assets.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-n, --name <name>', 'destination filename (taken from source if not set)')
  .option('-t, --type <type>', 'asset MIME type', 'application/octet-stream')
  .option('-a, --max-age <age_seconds>', 'max-age for Cache-Control', 31536000)
  .action(doAPush);
const cmdWeb = commander.program
  .command('web')
  .description('display web URLs');
cmdWeb
  .command('edit')
  .description('display editor URL')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doWebEdit);
cmdWeb
  .command('term')
  .description('display terminal URL')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-c, --cap', 'display inner URL with persistent token')
  .action(doWebTerm);
cmdWeb
  .command('debugger')
  .description('display debugger URL')
  .addHelpText('after', `
Implementation problems:
Does not set GLITCH_DEBUGGER. Do that yourself (snail setenv GLITCH_DEBUGGER
true).`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-c, --cap', 'display devtool URL with debugger token')
  .action(doWebDebugger);
commander.program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Local Variables:
// indent-tabs-mode: nil
// js-indent-level: 2
// End:

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const commander = require('commander');
const fetch = require('node-fetch').default;

// credentials

async function getPersistentToken() {
  return process.env.G_PERSISTENT_TOKEN;
}

async function boot() {
  const res = await fetch('https://api.glitch.com/boot?latestProjectOnly=true', {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error('response not ok ' + res.status);
  return await res.json();
}

// project selection

const remoteName = 'glitch';

async function getProjectDomainFromRemote() {
  const {stdout, stderr} = await util.promisify(childProcess.execFile)('git', ['remote', 'get-url', remoteName]);
  const remoteUrl = stdout.trim();
  const m = /https:\/\/(?:[\w-]+@)?api\.glitch\.com\/git\/([\w-]+)/.exec(remoteUrl);
  if (!m) return null;
  return m[1];
}

async function getProjectByDomain(domain) {
  const res = await fetch(`https://api.glitch.com/v1/projects/by/domain?domain=${domain}`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error('response not ok ' + res.status);
  const body = await res.json();
  return body[domain];
}

// commands

async function doRemote(domain) {
  const {user} = await boot();
  const url = `https://${user.gitAccessToken}@api.glitch.com/git/${domain}`;
  await util.promisify(childProcess.execFile)('git', ['remote', 'add', remoteName, url]);
}

async function doSetenv(name, value) {
  const env = {};
  env[name] = value;
  const res = await fetch(`https://api.glitch.com/projects/${await getProjectDomainFromRemote()}/setenv`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({env}),
  });
  if (!res.ok) throw new Error('response not ok ' + res.status)
}

async function doExec(command) {
  const projectDomain = await getProjectDomainFromRemote();
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
  if (!res.ok) throw new Error('response not ok ' + res.status);
  const body = await res.json();
  process.stdout.write(body.stdout);
  process.stderr.write(body.stderr);
}

async function doTerm() {
  const io = require('socket.io-client');

  const socket = io('https://api.glitch.com', {
    path: `/${await getProjectDomainFromRemote()}/console/${await getPersistentToken()}/socket.io`,
  });

  function handleResize() {
    socket.emit('resize', {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    });
  }

  socket.on('disconnect', () => {
    console.error('Socket disconnected');
    process.exit(1);
  });
  socket.on('error', (e) => {
    console.error(e);
  });
  socket.on('login', () => {
    process.stdin.setRawMode(true);
    handleResize();
  });
  socket.on('logout', () => {
    process.exit(0);
  });
  socket.on('data', (data) => {
    process.stdout.write(data);
  });

  process.stdout.on('resize', handleResize);
  process.stdin.on('data', (data) => {
    socket.emit('input', data);
  });
}

async function doLogs() {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomainFromRemote();
  const project = await getProjectByDomain(projectDomain);
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/logs?authorization=${await getPersistentToken()}`);
  ws.on('open', () => {
    setInterval(() => {
      ws.send('keep alive');
    }, 30000);
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.process == 'application') {
      console.log(msg.text);
    }
  });
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    console.error('web socket closed', code, reason);
    process.exit(1);
  });
}

async function doStop() {
  const projectDomain = await getProjectDomainFromRemote();
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/stop`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error('response not ok ' + res.status)
}

async function doAPush(source, cmd) {
  const FormData = require('form-data');

  const projectDomain = await getProjectDomainFromRemote();
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/policy`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error('response not ok ' + res.status);
  const body = await res.json();
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
  const key = keyPrefix + (cmd.opts().name || path.basename(source));
  const form = new FormData();
  form.append('key', key);
  form.append('Content-Type', cmd.opts().type);
  form.append('Cache-Control', `max-age=${cmd.opts().maxAge}`);
  form.append('AWSAccessKeyId', body.accessKeyId);
  form.append('acl', acl);
  form.append('policy', body.policy);
  form.append('signature', body.signature);
  form.append('file', fs.createReadStream(source));
  // node-fetch is variously annoying about how it sends FormData
  const res2 = await util.promisify(form.submit).call(form, `https://s3.amazonaws.com/${bucket}`);
  if (res2.statusCode < 200 || res2.statusCode >= 300) throw new Error('response not ok ' + res2.statusCode);
  console.log(`https://cdn.glitch.com/${encodeURIComponent(key)}?v=${Date.now()}`);
}

commander.program.storeOptionsAsProperties(false);
commander.program
  .command('remote <domain>')
  .description('set up the glitch git remote')
  .action(doRemote);
commander.program
  .command('setenv <name> <value>')
  .description('set an environment variable')
  .action(doSetenv);
commander.program
  .command('exec <command...>')
  .description('run a command in the project container')
  .on('--help', () => {
    console.log(`
Limitations:
Command line and output are not binary safe.
No output is returned until the process exits.

Implementation problems:
Output is not printed when command fails.`);
  })
  .action(doExec);
commander.program
  .command('term')
  .description('connect to a project terminal')
  .action(doTerm);
commander.program
  .command('logs')
  .description('watch application logs')
  .action(doLogs);
commander.program
  .command('stop')
  .description('stop project container')
  .action(doStop);
const cmdAsset = commander.program
  .command('asset')
  .alias('a')
  .description('manage CDN assets');
cmdAsset
  .command('push <source>')
  .description('upload an assset')
  .on('--help', () => {
    console.log(`
Implementation problems:
Does not maintain .glitch-assets.`);
  })
  .option('-n, --name <name>', 'destination filename (taken from source if not set)')
  .option('-t, --type <type>', 'asset MIME type', 'application/octet-stream')
  .option('-a, --max-age <age_seconds>', 'max-age for Cache-Control', 31536000)
  .action(doAPush);
commander.program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

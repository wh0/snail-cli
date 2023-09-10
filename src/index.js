#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const commander = require('commander');
const fetch = require('node-fetch').default;

const packageMeta = require('../package.json');

// credentials

function getPersistentTokenPath() {
  return path.join(os.homedir(), '.config', 'snail', 'persistent-token');
}

async function failIfPersistentTokenSaved() {
  const persistentTokenPath = getPersistentTokenPath();
  let persistentTokenExists = false;
  try {
    await fs.promises.stat(persistentTokenPath);
    persistentTokenExists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (persistentTokenExists) {
    throw new Error(`Persistent token already saved (${persistentTokenPath}). Delete that to authenticate again`);
  }
}

async function savePersistentToken(persistentToken) {
  const persistentTokenPath = getPersistentTokenPath();
  await fs.promises.mkdir(path.dirname(persistentTokenPath), {recursive: true});
  await fs.promises.writeFile(persistentTokenPath, persistentToken + '\n', {flag: 'wx'});
}

function getPersistentTokenFromEnv() {
  return process.env.G_PERSISTENT_TOKEN;
}

async function getPersistentTokenFromConfig() {
  const persistentTokenPath = getPersistentTokenPath();
  let data;
  try {
    data = await fs.promises.readFile(persistentTokenPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return data.trim();
}

async function getPersistentTokenHowever() {
  return getPersistentTokenFromEnv() || await getPersistentTokenFromConfig();
}

async function getPersistentToken() {
  const persistentToken = await getPersistentTokenHowever();
  if (!persistentToken) throw new Error(`Persistent token unset. Sign in (snail auth) or save (${getPersistentTokenPath()}) or set in environment (G_PERSISTENT_TOKEN)`);
  return persistentToken;
}

async function boot() {
  const res = await fetch('https://api.glitch.com/boot?latestProjectOnly=true', {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch v0 boot response ${res.status} not ok`);
  return await res.json();
}

// project selection

function getProjectDomainFromOpts(opts) {
  return opts.project;
}

const REMOTE_NAME = 'glitch';

async function getProjectDomainFromRemote() {
  let result;
  try {
    result = await util.promisify(childProcess.execFile)('git', ['remote', 'get-url', REMOTE_NAME]);
  } catch (e) {
    if (e.code === 2) return null;
    // Out of sympathy for places with older Git that doesn't yet have this
    // special exit code, we'll do some string matching too.
    if (typeof e.stderr === 'string' && e.stderr.includes('No such remote')) return null;
    throw e;
  }
  const remoteUrl = result.stdout.trim();
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

// user selection

async function getUserByLogin(login) {
  const res = await fetch(`https://api.glitch.com/v1/users/by/login?login=${login}`);
  if (!res.ok) throw new Error(`Glitch users by login response ${res.status} not ok`);
  const body = await res.json();
  if (!(login in body)) throw new Error(`Glitch user login ${login} not found`);
  return body[login];
}

// ot

function otNewId() {
  return crypto.randomBytes(6).toString('hex');
}

class OtClient {

  constructor(ws, opts) {
    this.ws = ws;
    this.opts = opts;
    this.clientId = null;
    this.version = null;
    this.masterPromised = null;
    this.masterRequested = null;
    this.docPromised = {};
    this.docRequested = {};
    this.opListRequested = {};
    this.onmessage = null;
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (this.opts.debug) {
        console.error('<', util.inspect(msg, {depth: null, colors: true}));
      }
      if (this.onmessage) {
        this.onmessage(msg);
      }
      switch (msg.type) {
        case 'master-state': {
          this.version = msg.state.version;
          const {resolve} = this.masterRequested;
          this.masterRequested = null;
          resolve(msg);
          break;
        }
        case 'register-document': {
          const doc = msg.document;
          const children = doc.children;
          doc.children = {};
          for (const k in children) {
            doc.children[k] = children[k].docId;
          }
          const {resolve} = this.docRequested[doc.docId];
          delete this.docRequested[doc.docId];
          resolve(doc);
          break;
        }
        case 'accepted-oplist': {
          const opList = msg.opList;
          const {resolve} = this.opListRequested[opList.id];
          delete this.opListRequested[opList.id];
          this.version = opList.version + 1;
          resolve();
          break;
        }
        case 'rejected-oplist': {
          const opList = msg.opList;
          const {reject} = this.opListRequested[opList.id];
          delete this.opListRequested[opList.id];
          reject(new Error(`oplist ${opList.id} rejected`));
          break;
        }
      }
    });
  }

  send(msg) {
    if (this.opts.debug) {
      console.error('>', util.inspect(msg, {depth: null, colors: true}));
    }
    this.ws.send(JSON.stringify(msg));
  }

  fetchMaster() {
    if (!this.masterPromised) {
      this.clientId = otNewId();
      this.masterPromised = new Promise((resolve, reject) => {
        this.masterRequested = {resolve, reject};
        this.send({
          type: 'master-state',
          clientId: this.clientId,
          // the editor also sends `force: true`
        });
      });
    }
    return this.masterPromised;
  }

  fetchDoc(docId) {
    if (!(docId in this.docPromised)) {
      this.docPromised[docId] = new Promise((resolve, reject) => {
        this.docRequested[docId] = {resolve, reject};
        this.send({
          type: 'register-document',
          docId,
        });
      });
    }
    return this.docPromised[docId];
  }

  broadcastOps(ops) {
    const id = otNewId();
    return new Promise((resolve, reject) => {
      this.opListRequested[id] = {resolve, reject};
      this.send({
        type: 'client-oplist',
        opList: {
          id,
          version: this.version,
          ops,
        },
      });
    });
  }

}

function otRequireDir(doc) {
  if (doc.docType !== 'directory') throw new Error(`document ${doc.docId} is not a directory`);
}

function otRequireNotDir(doc) {
  if (doc.docType === 'directory') throw new Error(`document ${doc.docId} is a directory`);
}

async function otFetchDot(c) {
  const root = await c.fetchDoc('root');
  return await c.fetchDoc(root.children['.']);
}

async function otResolveExisting(c, names) {
  let doc = await otFetchDot(c);
  for (const name of names) {
    otRequireDir(doc);
    if (name === '' || name === '.') continue;
    if (!(name in doc.children)) throw new Error(`${name} not found in document ${doc.docId}`);
    doc = await c.fetchDoc(doc.children[name]);
  }
  return doc;
}

async function otResolveOrCreateParents(c, ops, names, fallbackName) {
  let doc = await otFetchDot(c);
  let docIndex = 0;

  for (; docIndex < names.length; docIndex++) {
    otRequireDir(doc);
    const name = names[docIndex];
    if (name === '' || name === '.') continue;
    if (!(name in doc.children)) break;
    doc = await c.fetchDoc(doc.children[name]);
  }

  for (; docIndex < names.length - 1; docIndex++) {
    doc = {
      name: names[docIndex],
      docId: otNewId(),
      docType: 'directory',
      parentId: doc.docId,
    };
    ops.push({type: 'add', ...doc});
    doc.children = {};
  }

  if (doc.docType === 'directory') {
    const name = docIndex < names.length && names[docIndex] || fallbackName;
    if (name && name in doc.children) {
      doc = await c.fetchDoc(doc.children[name]);
      return {existing: doc};
    } else {
      return {parent: doc, name};
    }
  } else {
    return {existing: doc};
  }
}

// file utilities

async function guessSingleDestination(dst, name) {
  if (dst.endsWith(path.sep) || dst.endsWith(path.posix.sep)) return dst + name;
  let dstStats = null;
  try {
    dstStats = await fs.promises.stat(dst);
  } catch (e) {
    if (e.code === 'ENOENT') return dst;
    throw e;
  }
  if (dstStats.isDirectory()) return path.join(dst, name);
  return dst;
}

// shell helpers

function shellWord(s) {
  return '\'' + s.replace(/'/g, '\'"\'"\'') + '\'';
}

// interaction

function noCompletions(line) {
  return [];
}

function promptTrimmed(query) {
  const readline = require('readline');
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      completer: noCompletions,
      historySize: 0,
    });
    rl.on('close', () => {
      reject(new Error('readline close'));
    });
    rl.question(`${query}: `, (answer) => {
      resolve(answer.trim());
      rl.close();
    });
  });
}

function promptPassword() {
  const readline = require('readline');
  return new Promise((resolve, reject) => {
    const maskedStderr = Object.create(process.stdout);
    maskedStderr.write = (chunk, encoding, callback) => {
      const masked = chunk
        .replace(
          // eslint-disable-next-line no-control-regex
          /(^Password: )|(\x1b\x5b[\x20-\x3f]*[\x40-\x7f])|(.)/g,
          (_, p, cs, ch) => p || cs || '*',
        );
      process.stderr.write(masked);
    };
    const rl = readline.createInterface({
      input: process.stdin,
      output: maskedStderr,
      completer: noCompletions,
    });
    rl.on('close', () => {
      reject(new Error('readline close'));
    });
    rl.question('Password: ', (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

// Glitch constants

const ACCESS_LEVEL_MEMBER = 20;

// commands

async function doAuthAnon() {
  await failIfPersistentTokenSaved();

  const res = await fetch('https://api.glitch.com/v1/users/anon', {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Glitch users anon response ${res.status} not ok`);
  const user = await res.json();

  await savePersistentToken(user.persistentToken);
}

async function doAuthSendEmail(email, opts) {
  if (opts.interactive) {
    await failIfPersistentTokenSaved();
  }

  const emailPrompted = email || await promptTrimmed('Email');
  const res = await fetch('https://api.glitch.com/v1/auth/email/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      emailAddress: emailPrompted,
    }),
  });
  if (!res.ok) throw new Error(`Glitch auth email response ${res.status} not ok`);

  if (opts.interactive) {
    const codePrompted = await promptTrimmed('Code');
    const codeRes = await fetch(`https://api.glitch.com/v1/auth/email/${codePrompted}`, {
      method: 'POST',
    });
    if (!codeRes.ok) throw new Error(`Glitch auth email response ${codeRes.status} not ok`);
    const body = await codeRes.json();

    await savePersistentToken(body.user.persistentToken);
  }
}

async function doAuthCode(code) {
  await failIfPersistentTokenSaved();

  const codePrompted = code || await promptTrimmed('Code');
  const res = await fetch(`https://api.glitch.com/v1/auth/email/${codePrompted}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Glitch auth email response ${res.status} not ok`);
  const body = await res.json();

  await savePersistentToken(body.user.persistentToken);
}

async function doAuthPassword(email, password) {
  await failIfPersistentTokenSaved();

  const emailPrompted = email || await promptTrimmed('Email');
  const passwordPrompted = password || await promptPassword();
  const res = await fetch('https://api.glitch.com/v1/auth/password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      emailAddress: emailPrompted,
      password: passwordPrompted,
    }),
  });
  if (!res.ok) throw new Error(`Glitch auth password response ${res.status} not ok`);
  const body = await res.json();

  await savePersistentToken(body.user.persistentToken);
}

async function doWhoami(opts) {
  const {user} = await boot();
  if (opts.numeric) {
    console.log('' + user.id);
  } else {
    if (!user.login) throw new Error('Logged in as anonymous user. Pass -n to get ID');
    console.log(user.login);
  }
}

async function doRemote(opts) {
  const projectDomain = getProjectDomainFromOpts(opts);
  if (!projectDomain) throw new Error('Unable to determine which project. Specify (-p)');
  const {user} = await boot();
  const url = `https://${user.gitAccessToken}@api.glitch.com/git/${projectDomain}`;
  await util.promisify(childProcess.execFile)('git', ['remote', 'add', REMOTE_NAME, url]);
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
  if (!res.ok) throw new Error(`Glitch v0 projects setenv response ${res.status} not ok`);
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
  if (res.ok) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout);
  } else if (res.status === 500) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout);
    process.exitCode = body.signal || body.code;
  } else {
    throw new Error(`Glitch v0 projects exec response ${res.status} not ok`);
  }
}

async function doTerm(command, opts) {
  const io = require('socket.io-client');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/singlePurposeTokens/terminal`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects single purpose tokens terminal response ${res.status} not ok`);
  const body = await res.json();

  let done = false;
  const ioOpts = {
    path: `/console/${body.token}/socket.io`,
  };
  if (opts.setTransports) {
    ioOpts.transports = ['websocket'];
  }
  const socket = io('https://api.glitch.com', ioOpts);

  function handleResize() {
    socket.emit('resize', {
      cols: process.stdout.columns,
      rows: process.stdout.rows,
    });
  }

  socket.once('disconnect', (reason) => {
    if (!done || reason !== 'io client disconnect') {
      console.error(`Glitch console disconnected: ${reason}`);
      process.exit(1);
    }
  });
  socket.on('error', (e) => {
    console.error(e);
  });
  socket.once('login', () => {
    if (process.stdin.isTTY && opts.raw) {
      process.stdin.setRawMode(true);
    }
    handleResize();
    if (command.length) {
      socket.emit('input', command.join(' ') + '\n');
    }
    process.stdout.on('resize', handleResize);
    process.stdin.on('data', (data) => {
      socket.emit('input', data);
    });
  });
  socket.once('logout', () => {
    done = true;
    process.stdin.pause();
    socket.close();
  });
  socket.on('data', (data) => {
    process.stdout.write(data);
  });
}

async function doPipe(command, opts) {
  const io = require('socket.io-client');

  // see pipe-wrap.js
  const WRAPPER_SRC = 'var t="base64",e="data",{stdin:o,stdout:r,argv:[,s]}=process,i=null,n=t=>{i&&(clearTimeout(i),i=null),r.write(t+"\\n")},a=require("child_process").spawn(Buffer.from(s,t).toString("utf8"),{stdio:"pipe",shell:!0}),d="";o.setRawMode(!0),o.setEncoding("ascii"),o.on(e,(e=>{i||(i=setTimeout((()=>{n(")p")}),4e3));var o=(d+e).split("\\n");for(var r of(d=o.pop(),o))r?a.stdin.write(Buffer.from(r,t)):a.stdin.end()})),n(")s"),a.stdout.on(e,(e=>{n(")o"+e.toString(t))})),a.stderr.on(e,(e=>{n(")e"+e.toString(t))})),a.on("exit",((t,e)=>{n(")r"+(e?1:t)),o.pause()}));';

  let started = false;
  let returned = false;
  let recvBuf = '';

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/singlePurposeTokens/terminal`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects single purpose tokens terminal response ${res.status} not ok`);
  const body = await res.json();

  let done = false;
  const ioOpts = {
    path: `/console/${body.token}/socket.io`,
  };
  if (opts.setTransports) {
    ioOpts.transports = ['websocket'];
  }
  const socket = io('https://api.glitch.com', ioOpts);

  socket.once('disconnect', (reason) => {
    if (!done || reason !== 'io client disconnect') {
      console.error(`Glitch console disconnected: ${reason}`);
      process.exit(1);
    }
  });
  socket.on('error', (e) => {
    console.error(e);
  });
  socket.on('data', (data) => {
    const parts = (recvBuf + data).split('\n');
    recvBuf = parts.pop();
    for (const part of parts) {
      if (part[0] === ')') {
        switch (part[1]) {
          case 's':
            if (started) continue;
            started = true;
            process.stdin.on('data', (chunk) => {
              socket.emit('input', chunk.toString('base64') + '\n');
            });
            process.stdin.on('end', () => {
              socket.emit('input', '\n');
            });
            continue;
          case 'p':
            continue;
          case 'o':
            process.stdout.write(Buffer.from(part.slice(2), 'base64'));
            continue;
          case 'e':
            process.stderr.write(Buffer.from(part.slice(2), 'base64'));
            continue;
          case 'r':
            if (returned) continue;
            returned = true;
            process.stdin.pause();
            process.exitCode = +part.slice(1);
            continue;
        }
      }
      if (opts.debug) {
        console.error(part);
      }
    }
  });
  socket.once('login', () => {
    socket.emit('input', `unset HISTFILE && exec /opt/nvm/versions/node/v10/bin/node -e ${shellWord(WRAPPER_SRC)} ${shellWord(Buffer.from(command.join(' '), 'utf8').toString('base64'))}\n`);
  });
  socket.once('logout', () => {
    done = true;
    socket.close();
    if (!returned) {
      console.error('Received console logout without receiving return message');
      process.exitCode = 1;
    }
  });
}

async function doRsync(args) {
  const rsyncArgs = ['-e', 'snail rsync-rsh --', ...args];
  const c = childProcess.spawn('rsync', rsyncArgs, {
    stdio: 'inherit',
  });
  c.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : code;
  });
}

async function doRsyncRsh(args) {
  const host = args.shift();
  await commander.program.parseAsync(['pipe', '-p', host, '--', ...args], {from: 'user'});
}

const SSHD_CONFIG = `AcceptEnv LANG LC_*
AuthenticationMethods publickey
ChallengeResponseAuthentication no
HostKey /app/.data/.snail/ssh/ssh_host_rsa_key
HostKey /app/.data/.snail/ssh/ssh_host_dsa_key
HostKey /app/.data/.snail/ssh/ssh_host_ecdsa_key
HostKey /app/.data/.snail/ssh/ssh_host_ed25519_key
PrintMotd no
Subsystem sftp /tmp/.snail/unpack/usr/lib/openssh/sftp-server
UsePrivilegeSeparation no
X11Forwarding yes
`;

const SCRIPT_INSTALL_SSHD = `mkdir -p /tmp/.snail

if [ ! -e /tmp/.snail/stamp-sshd-unpack ]; then
  mkdir -p /tmp/.snail/unpack
  if [ ! -e /tmp/.snail/stamp-sshd-download ]; then
    printf "Downloading debs\\n" >&2
    mkdir -p /tmp/.snail/deb
    (
      cd /tmp/.snail/deb
      apt-get download openssh-server openssh-sftp-server >&2
    )
  fi
  printf "Unpacking debs\\n" >&2
  dpkg -x /tmp/.snail/deb/openssh-sftp-server_*.deb /tmp/.snail/unpack
  dpkg -x /tmp/.snail/deb/openssh-server_*.deb /tmp/.snail/unpack
  touch /tmp/.snail/stamp-sshd-unpack
fi`;

const SCRIPT_GEN_HOST_KEY = `if [ ! -e /app/.data/.snail/stamp-sshd-key ]; then
  printf "Generating host keys\\n" >&2
  mkdir -p /app/.data/.snail/ssh
  ssh-keygen -q -f /app/.data/.snail/ssh/ssh_host_rsa_key -N "" -t rsa >&2
  ssh-keygen -l -f /app/.data/.snail/ssh/ssh_host_rsa_key >&2
  ssh-keygen -q -f /app/.data/.snail/ssh/ssh_host_dsa_key -N "" -t dsa >&2
  ssh-keygen -l -f /app/.data/.snail/ssh/ssh_host_dsa_key >&2
  ssh-keygen -q -f /app/.data/.snail/ssh/ssh_host_ecdsa_key -N "" -t ecdsa >&2
  ssh-keygen -l -f /app/.data/.snail/ssh/ssh_host_ecdsa_key >&2
  ssh-keygen -q -f /app/.data/.snail/ssh/ssh_host_ed25519_key -N "" -t ed25519 >&2
  ssh-keygen -l -f /app/.data/.snail/ssh/ssh_host_ed25519_key >&2
  touch /app/.data/.snail/stamp-sshd-key
fi`;

const SCRIPT_CREATE_SSHD_CONFIG = `if [ ! -e /tmp/.snail/stamp-sshd-config ]; then
  printf "Creating config\\n" >&2
  mkdir -p /tmp/.snail/ssh
  cat >/tmp/.snail/ssh/sshd_config <<EOF
${SSHD_CONFIG}EOF
  touch /tmp/.snail/stamp-sshd-config
fi`;

async function doSshCopyId(fakeHost, opts) {
  const projectDomain = fakeHost.split('.')[0];
  const project = await getProjectByDomain(projectDomain);
  let publicKeyB64;
  if (opts.i) {
    const pubPath = opts.i.replace(/(\.pub)?$/, '.pub');
    publicKeyB64 = await fs.promises.readFile(pubPath, 'base64');
  } else {
    const sshDir = path.join(os.homedir(), '.ssh');
    const DEFAULT_IDS = [
      'id_rsa',
      'id_dsa',
      'id_ecdsa',
      'id_ecdsa_sk',
      'id_ed25519',
      'id_ed25519_sk',
      'id_xmss',
    ];
    let found = false;
    for (const t of DEFAULT_IDS) {
      const pubPath = path.join(sshDir, `${t}.pub`);
      try {
        publicKeyB64 = await fs.promises.readFile(pubPath, 'base64');
        found = true;
        break;
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        console.error(e);
      }
    }
    if (!found) throw new Error('No identity file found in default locations. Generate (ssh-keygen) or specify path (-i)');
  }
  const command = `set -eu
mkdir -p /app/.ssh
base64 -d >>/app/.ssh/authorized_keys <<SNAIL_EOF
${publicKeyB64}
SNAIL_EOF`;
  const res = await fetch(`https://api.glitch.com/projects/${project.id}/exec`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      command,
    }),
  });
  if (res.ok) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout);
  } else if (res.status === 500) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout);
    process.exitCode = body.signal || body.code;
  } else {
    throw new Error(`Glitch v0 projects exec response ${res.status} not ok`);
  }
}

async function doSshKeyscan(fakeHost) {
  const projectDomain = fakeHost.split('.')[0];
  const project = await getProjectByDomain(projectDomain);
  const command = `set -eu

${SCRIPT_GEN_HOST_KEY}

cat /app/.data/.snail/ssh/ssh_host_*_key.pub`;
  const res = await fetch(`https://api.glitch.com/projects/${project.id}/exec`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      command,
    }),
  });
  if (res.ok) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout.replace(/^.*\n/gm, `${fakeHost} $&`));
  } else if (res.status === 500) {
    const body = await res.json();
    process.stderr.write(body.stderr);
    process.stdout.write(body.stdout);
    process.exitCode = body.signal || body.code;
  } else {
    throw new Error(`Glitch v0 projects exec response ${res.status} not ok`);
  }
}

async function doSshProxy(fakeHost) {
  const projectDomain = fakeHost.split('.')[0];
  const script = `set -eu

${SCRIPT_INSTALL_SSHD}

${SCRIPT_CREATE_SSHD_CONFIG}

${SCRIPT_GEN_HOST_KEY}

exec /tmp/.snail/unpack/usr/sbin/sshd -f /tmp/.snail/ssh/sshd_config -i -e`;
  await commander.program.parseAsync(['pipe', '-p', projectDomain, '--', script], {from: 'user'});
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
    if (opts.all) {
      console.log(msg);
    } else {
      if (msg.process !== 'signal') {
        console.log(msg.text);
      }
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
  if (!res.ok) throw new Error(`Glitch projects stop response ${res.status} not ok`);
}

async function doDownload(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/project/download/?authorization=${await getPersistentToken()}&projectId=${project.id}`);
  if (!res.ok) throw new Error(`Glitch project download response ${res.status} not ok`);
  let dstStream;
  if (opts.output === '-') {
    dstStream = process.stdout;
  } else {
    let dst;
    if (opts.output) {
      dst = opts.output;
    } else {
      dst = /attachment; filename=([\w-]+\.tgz)/.exec(res.headers.get('Content-Disposition'))[1];
    }
    dstStream = fs.createWriteStream(dst);
  }
  res.body.pipe(dstStream);
}

async function doAPolicy(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/policy?contentType=${encodeURIComponent(opts.type)}`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects policy response ${res.status} not ok`);
  const body = await res.json();
  console.log(JSON.stringify(body));
}

async function doAPush(src, opts) {
  const FormData = require('form-data');

  const srcSize = (await fs.promises.stat(src)).size;
  const srcStream = fs.createReadStream(src);

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const policyRes = await fetch(`https://api.glitch.com/v1/projects/${project.id}/policy?contentType=${encodeURIComponent(opts.type)}`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!policyRes.ok) throw new Error(`Glitch projects policy response ${policyRes.status} not ok`);
  const body = await policyRes.json();
  const policy = JSON.parse(Buffer.from(body.policy, 'base64').toString('utf8'));
  let bucket, keyPrefix, acl;
  for (const condition of policy.conditions) {
    if (condition instanceof Array) {
      if (condition[1] === '$key' && condition[0] === 'starts-with') keyPrefix = condition[2];
    } else {
      if ('bucket' in condition) bucket = condition.bucket;
      if ('acl' in condition) acl = condition.acl;
    }
  }
  const key = opts.name || path.basename(src);
  const awsKey = keyPrefix + key;
  const form = new FormData();
  form.append('key', awsKey);
  form.append('Content-Type', opts.type);
  form.append('Cache-Control', `max-age=${opts.maxAge}`);
  form.append('AWSAccessKeyId', body.accessKeyId);
  form.append('acl', acl);
  form.append('policy', body.policy);
  form.append('signature', body.signature);
  form.append('file', srcStream, {knownLength: srcSize});
  // node-fetch is variously annoying about how it sends FormData
  // https://github.com/node-fetch/node-fetch/pull/1020
  const uploadRes = await util.promisify(form.submit).call(form, `https://s3.amazonaws.com/${bucket}`);
  if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) throw new Error(`S3 upload response ${uploadRes.statusCode} not ok`);
  // empirically, 20MiB works, (20Mi + 1)B gives 503 on cdn.glitch.global
  const cdnHost = srcSize > (20 * 1024 * 1024) ? 'cdn.glitch.me' : 'cdn.glitch.global';
  console.log(`https://${cdnHost}/${keyPrefix}${encodeURIComponent(key)}?v=${Date.now()}`);
}

async function doACp(src, dst, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  // don't want protocol, host, ?v= thingy, etc.
  let sourceKey = new URL(src, 'https://cdn.glitch.global/').pathname;
  // key doesn't have leading slash
  sourceKey = sourceKey.replace(/^\//, '');
  // for convenience, allow shorthand for assets in current project
  if (!/\/|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}%2F/i.test(sourceKey)) {
    sourceKey = `${project.id}/${sourceKey}`;
  }
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/asset/${encodeURIComponent(dst)}`, {
    method: 'PUT',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceKey,
    }),
  });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Glitch projects asset response ${res.statusCode} not ok`);
  console.log(`https://cdn.glitch.global/${project.id}/${encodeURIComponent(dst)}?v=${Date.now()}`);
}

async function doOtPush(src, dst, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const dstNames = dst.split('/');
  let srcBasename;
  let content;
  if (src === '-') {
    srcBasename = null;
    content = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
      });
      process.stdin.on('end', () => {
        resolve(buf);
      });
    });
  } else {
    srcBasename = path.basename(src);
    content = await fs.promises.readFile(src, 'utf8');
  }

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        const ops = [];
        const dstAccess = await otResolveOrCreateParents(c, ops, dstNames, srcBasename);
        if ('existing' in dstAccess) {
          otRequireNotDir(dstAccess.existing);
          if ('base64Content' in dstAccess.existing) {
            ops.push({
              type: 'unlink',
              docId: dstAccess.existing.docId,
            });
            const doc = {
              name: dstAccess.existing.name,
              docId: otNewId(),
              docType: 'file',
              parentId: dstAccess.existing.parentId,
            };
            ops.push({type: 'add', ...doc});
            ops.push({
              type: 'insert',
              docId: doc.docId,
              position: 0,
              text: content,
            });
          } else {
            ops.push({
              type: 'remove',
              docId: dstAccess.existing.docId,
              position: 0,
              text: dstAccess.existing.content,
            });
            ops.push({
              type: 'insert',
              docId: dstAccess.existing.docId,
              position: 0,
              text: content,
            });
          }
        } else {
          if (!dstAccess.name) throw new Error('Need explicit dst filename to push from stdin');
          const doc = {
            name: dstAccess.name,
            docId: otNewId(),
            docType: 'file',
            parentId: dstAccess.parent.docId,
          };
          ops.push({type: 'add', ...doc});
          ops.push({
            type: 'insert',
            docId: doc.docId,
            position: 0,
            text: content,
          });
        }

        await c.fetchMaster();
        await c.broadcastOps(ops);

        done = true;
        ws.close();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtPull(src, dst, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const srcNames = src.split('/');
  const dstInfo = dst === '-' ? {stdout: true} : {file: await guessSingleDestination(dst, srcNames[srcNames.length - 1])};

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        const doc = await otResolveExisting(c, srcNames);

        done = true;
        ws.close();

        otRequireNotDir(doc);
        if ('base64Content' in doc) {
          if ('stdout' in dstInfo) {
            process.stdout.write(doc.base64Content, 'base64');
          } else {
            await fs.promises.writeFile(dstInfo.file, doc.base64Content, 'base64');
          }
        } else {
          if ('stdout' in dstInfo) {
            process.stdout.write(doc.content);
          } else {
            await fs.promises.writeFile(dstInfo.file, doc.content);
          }
        }
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtMv(src, dst, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const srcNames = src.split('/');
  const srcBasename = path.posix.basename(src);
  if (srcBasename === '' || srcBasename === '.' || srcBasename === '..') throw new Error('Invalid src basename');
  const dstNames = dst.split('/');

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        const doc = await otResolveExisting(c, srcNames);

        const ops = [];
        const dstAccess = await otResolveOrCreateParents(c, ops, dstNames, srcBasename);
        if ('existing' in dstAccess) {
          otRequireNotDir(doc);
          otRequireNotDir(dstAccess.existing);
          ops.push({
            type: 'rename',
            docId: doc.docId,
            newName: dstAccess.existing.name,
            newParentId: dstAccess.existing.parentId,
          });
        } else {
          ops.push({
            type: 'rename',
            docId: doc.docId,
            newName: dstAccess.name,
            newParentId: dstAccess.parent.docId,
          });
        }

        await c.fetchMaster();
        await c.broadcastOps(ops);

        done = true;
        ws.close();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtRm(pathArg, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const names = pathArg.split('/');

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        const doc = await otResolveExisting(c, names);

        const ops = [];
        ops.push({
          type: 'unlink',
          docId: doc.docId,
        });

        await c.fetchMaster();
        await c.broadcastOps(ops);

        done = true;
        ws.close();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtLs(pathArg, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const names = pathArg.split('/');

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        const doc = await otResolveExisting(c, names);

        done = true;
        ws.close();

        otRequireDir(doc);
        for (const name in doc.children) {
          console.log(name);
        }
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtRequestJoin(opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const {user} = await boot();

  for (const permission of project.permissions) {
    if (permission.userId === user.id) {
      console.error(`Already have permission at access level ${permission.accessLevel}`);
      return;
    }
  }

  const nagUser = {
    avatarUrl: user.avatarUrl,
    avatarThumbnailUrl: user.avatarThumbnailUrl,
    awaitingInvite: true,
    id: user.id,
    name: user.name,
    login: user.login,
    color: user.color,
    // I personally find it weird that Glitch relies on what we report
    // ourselves, to the point where it crashes if this is absent. Snail is
    // honest here.
    projectPermission: {
      userId: user.id,
      projectId: project.id,
      accessLevel: 0,
    },
  };
  if (opts.randomName) {
    if (!nagUser.avatarUrl) {
      nagUser.avatarUrl = 'https://snail-cli.glitch.me/join.svg';
    }
    nagUser.name = `snail-${crypto.randomBytes(2).toString('hex')}`;
    nagUser.color = '#c00040';
  }

  let done = false;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${user.persistentToken}`);
  const c = new OtClient(ws, opts);

  let nagTimer = null;
  function nag() {
    c.send({
      type: 'broadcast',
      payload: {
        user: nagUser,
      },
    });
  }

  let inviteRequested = null;
  const invitePromised = new Promise((resolve, reject) => {
    inviteRequested = {resolve, reject};
  });
  c.onmessage = (msg) => {
    if (msg.type === 'broadcast' && 'user' in msg.payload) {
      if (msg.payload.user.id === user.id && msg.payload.user.invited) {
        // And yet here we are doing the same thing, trusting the broadcast
        // about our invite.
        const {resolve} = inviteRequested;
        inviteRequested = null;
        resolve(msg.payload.user);
      }
    }
  };

  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    if (!done || code !== 1000) {
      console.error(`Glitch OT closed: ${code} ${reason}`);
      process.exit(1);
    }
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        await c.fetchMaster();

        console.error(`Requesting to join as ${nagUser.name || nagUser.login || 'Anonymous'}`);
        nag();
        nagTimer = setInterval(nag, 10000);

        const invitedUser = await invitePromised;

        clearInterval(nagTimer);
        c.send({
          type: 'broadcast',
          payload: {
            user: {
              avatarUrl: user.avatarUrl,
              avatarThumbnailUrl: user.avatarThumbnailUrl,
              awaitingInvite: false,
              id: user.id,
              // I'd like to reset the name and color to the real ones in the
              // `--random-name` case, but Glitch doesn't treat these fields
              // as observable, so they don't actually update in the editor.
              name: user.name,
              login: user.login,
              color: user.color,
              invited: true,
              projectPermission: {
                userId: user.id,
                projectId: project.id,
                accessLevel: invitedUser.projectPermission.accessLevel,
              },
            },
          },
        });

        done = true;
        ws.close();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doOtStatus(opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const LINES_PER_HEADER = 23;
  let linesUntilHeader = 0;
  const ws = new WebSocket(`wss://api.glitch.com/${project.id}/ot?authorization=${await getPersistentToken()}`);
  const c = new OtClient(ws, opts);
  c.onmessage = (msg) => {
    if (msg.type === 'broadcast' && msg.payload.type === 'project-stats') {
      if (!linesUntilHeader) {
        console.log('       Time  Memory                Disk                 CPU');
        linesUntilHeader = LINES_PER_HEADER;
      }

      const p = msg.payload;
      const timeD = new Date(p.timeNs / 1000000);
      const timeCol = timeD.toLocaleTimeString().padStart(11);
      const memoryP = (p.memoryUsage / p.memoryLimit * 100).toFixed(0).padStart(3);
      const memoryUsageM = (p.memoryUsage / (1 << 20)).toFixed(0).padStart(3);
      const memoryLimitM = (p.memoryLimit / (1 << 20)).toFixed(0).padStart(3);
      const diskP = (p.diskUsage / p.diskSize * 100).toFixed(0).padStart(3);
      const diskUsageM = (p.diskUsage / (1 << 20)).toFixed(0).padStart(3);
      const diskSizeM = (p.diskSize / (1 << 20)).toFixed(0).padStart(3);
      const cpuP = ((p.quotaUsagePercent || 0) * 100).toFixed(0).padStart(3);
      console.log(`${timeCol}    ${memoryP}% ${memoryUsageM}MB / ${memoryLimitM}MB  ${diskP}% ${diskUsageM}MB / ${diskSizeM}MB  ${cpuP}%`);

      linesUntilHeader--;
    }
  };

  ws.on('error', (e) => {
    console.error(e);
  });
  ws.on('close', (code, reason) => {
    console.error(`Glitch OT closed: ${code} ${reason}`);
    process.exit(1);
  });
  ws.on('open', () => {
    if (opts.debug) {
      console.error('* open');
    }
    (async () => {
      try {
        await c.fetchMaster();
      } catch (e) {
        console.error(e);
        process.exit(1);
      }
    })();
  });
}

async function doHours() {
  const {user} = await boot();
  const persistentToken = await getPersistentToken();
  const uptimeRes = await fetch(`https://api.glitch.com/v1/users/${user.id}/uptime`, {
    headers: {
      'Authorization': persistentToken,
    },
  });
  if (!uptimeRes.ok) throw new Error(`Glitch users uptime response ${uptimeRes.status} not ok`);
  const uptimeBody = await uptimeRes.json();

  if (!uptimeBody.accountInGoodStanding) {
    console.log('Account not in good standing');
  }
  console.log(`Total: ${uptimeBody.consumedHours.toFixed(2)} / ${uptimeBody.allowanceHours.toFixed(2)}`);

  const projectIds = Object.keys(uptimeBody.hoursByProject);
  projectIds.sort((a, b) => uptimeBody.hoursByProject[a] - uptimeBody.hoursByProject[b]);

  console.log('Domain                                    Hours');
  const LIMIT = 100;
  for (let i = 0; i < projectIds.length; i += LIMIT) {
    const batch = projectIds.slice(i, i + LIMIT);
    const idParams = batch.map((id) => `id=${id}`).join('&');
    const projectsRes = await fetch(`https://api.glitch.com/v1/projects/by/id?${idParams}`, {
      headers: {
        'Authorization': persistentToken,
      },
    });
    if (!projectsRes.ok) throw new Error(`Glitch projects by ID response ${projectsRes.status} not ok`);
    const projects = await projectsRes.json();
    for (const id of batch) {
      let domain;
      if (id in projects) {
        domain = projects[id].domain;
      } else {
        domain = `(${id})`;
      }
      const domainCol = domain.padEnd(38);
      const hoursCol = uptimeBody.hoursByProject[id].toFixed(2).padStart(7);
      console.log(`${domainCol}  ${hoursCol}`);
    }
  }
}

async function doProjectCreate(domain, opts) {
  const fromDomain = opts.remix || 'glitch-hello-node';
  const reqBody = {};
  if (domain) {
    reqBody.domain = domain;
  }
  const res = await fetch(`https://api.glitch.com/v1/projects/by/domain/${fromDomain}/remix`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) throw new Error(`Glitch projects by domain remix response ${res.status} not ok`);
  const project = await res.json();
  console.log(project.domain);
  if (opts.remote) {
    try {
      const {user} = await boot();
      const url = `https://${user.gitAccessToken}@api.glitch.com/git/${project.domain}`;
      await util.promisify(childProcess.execFile)('git', ['remote', 'add', REMOTE_NAME, url]);
    } catch (e) {
      console.error(e);
    }
  }
}

async function doProjectInfo(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  console.log(`\
ID                ${project.id}
Domain            ${project.domain}
Description       ${project.description}
Privacy           ${project.privacy}
Application type  ${project.appType}
Last edited       ${new Date(project.updatedAt).toLocaleString()}
Created at        ${new Date(project.createdAt).toLocaleString()}`);
}

async function doProjectUpdate(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  let any = false;
  const reqBody = {};
  if ('domain' in opts) {
    any = true;
    reqBody.domain = opts.domain;
  }
  if ('description' in opts) {
    any = true;
    reqBody.description = opts.description;
  }
  if ('private' in opts) {
    any = true;
    reqBody.private = opts.private;
  }
  if ('privacy' in opts) {
    any = true;
    reqBody.privacy = opts.privacy;
  }
  if (!any) return;
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) throw new Error(`Glitch projects patch response ${res.status} not ok`);
}

async function doProjectDelete(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}`, {
    method: 'DELETE',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects delete response ${res.status} not ok`);
}

async function doProjectUndelete(opts) {
  const projectDomain = await getProjectDomain(opts);
  // is there a way to get a deleted project by domain in the v1 API?
  // const {user} = await boot();
  // `https://api.glitch.com/v1/users/${user.id}/deletedProjects?limit=1&orderKey=domain&orderDirection=DESC&lastOrderValue=${projectDomain}%00`
  const projectRes = await fetch(`https://api.glitch.com/projects/${projectDomain}?showDeleted=true`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!projectRes.ok) throw new Error(`Glitch v0 projects response ${projectRes.status} not ok`);
  const project = await projectRes.json();
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/undelete`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects undelete response ${res.status} not ok`);
}

async function doProjectList(opts) {
  const {user} = await boot();
  const persistentToken = await getPersistentToken();

  console.log('Domain                                  Privacy          Application type  Last edited  Description');
  const LIMIT = 100; // dashboard uses 100
  let pageParam = '';
  while (true) {
    let body;
    if (opts.deleted) {
      const res = await fetch(`https://api.glitch.com/v1/users/${user.id}/deletedProjects?limit=${LIMIT}&orderKey=createdAt&orderDirection=ASC${pageParam}`, {
        headers: {
          'Authorization': persistentToken,
        },
      });
      if (!res.ok) throw new Error(`Glitch users deleted projects response ${res.status} not ok`);
      body = await res.json();
    } else {
      const res = await fetch(`https://api.glitch.com/v1/users/${user.id}/projects?limit=${LIMIT}&orderKey=createdAt&orderDirection=ASC${pageParam}`, {
        headers: {
          'Authorization': persistentToken,
        },
      });
      if (!res.ok) throw new Error(`Glitch users projects response ${res.status} not ok`);
      body = await res.json();
    }

    for (const project of body.items) {
      const domainCol = project.domain.padEnd(38);
      const privacyCol = project.privacy.padEnd(15);
      const typeCol = ('' + project.appType).padEnd(16);
      const edited = project.permission && project.permission.userLastAccess;
      const editedCol = (edited ? new Date(edited).toLocaleDateString() : '').padStart(11);
      const descriptionCol = project.description.replace(/\n[\s\S]*/, '...');
      console.log(`${domainCol}  ${privacyCol}  ${typeCol}  ${editedCol}  ${descriptionCol}`);
    }

    if (!body.hasMore) break;
    pageParam = `&lastOrderValue=${encodeURIComponent(body.lastOrderValue)}`;
  }
}

async function doMemberAdd(login, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const userId = opts.numeric ? +login : (await getUserByLogin(login)).id;

  const res = await fetch(`https://api.glitch.com/project_permissions/${project.id}`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId,
      projectId: project.id,
      accessLevel: ACCESS_LEVEL_MEMBER,
    }),
  });
  if (!res.ok) throw new Error(`Glitch v0 project permissions response ${res.status} not ok`);
}

async function doMemberRm(login, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const userId = opts.numeric ? +login : (await getUserByLogin(login)).id;

  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/users/${userId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects users delete response ${res.status} not ok`);
}

async function doMemberLeave(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const {user} = await boot();

  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/users/${user.id}`, {
    method: 'DELETE',
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects users delete response ${res.status} not ok`);
}

async function doMemberList(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const idParams = project.permissions.map((permission) => `id=${permission.userId}`).join('&');
  const res = await fetch(`https://api.glitch.com/v1/users/by/id?${idParams}`);
  if (!res.ok) throw new Error(`Glitch users by ID response ${res.status} not ok`);
  const users = await res.json();
  console.log('   User ID  Access level  User login');
  for (const permission of project.permissions) {
    const userIdCol = ('' + permission.userId).padStart(10);
    const accessLevelCol = ('' + permission.accessLevel).padStart(12);
    const login = users[permission.userId].login;
    const userLoginCol = typeof login === 'string' ? login : `(${login})`;
    console.log(`${userIdCol}  ${accessLevelCol}  ${userLoginCol}`);
  }
}

async function doDomainAdd(domain, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/domains`, {
    method: 'POST',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({domain}),
  });
  if (!res.ok) throw new Error(`Glitch projects domains response ${res.status} not ok`);
}

async function doDomainRm(domain, opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/domains`, {
    method: 'DELETE',
    headers: {
      'Authorization': await getPersistentToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({domain}),
  });
  if (!res.ok) throw new Error(`Glitch projects domains delete response ${res.status} not ok`);
}

async function doDomainList(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/domains`, {
    headers: {
      'Authorization': await getPersistentToken(),
    },
  });
  if (!res.ok) throw new Error(`Glitch projects domains response ${res.status} not ok`);
  const body = await res.json();
  for (const domain of body.items) {
    console.log(domain.hostname);
  }
}

async function doWebApp(opts) {
  console.log(`https://${await getProjectDomain(opts)}.glitch.me/`);
}

async function doWebDetails(opts) {
  console.log(`https://glitch.com/~${await getProjectDomain(opts)}`);
}

async function doWebEdit(opts) {
  console.log(`https://glitch.com/edit/#!/${await getProjectDomain(opts)}`);
}

async function doWebTerm(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  if (opts.cap) {
    const res = await fetch(`https://api.glitch.com/v1/projects/${project.id}/singlePurposeTokens/terminal`, {
      method: 'POST',
      headers: {
        'Authorization': await getPersistentToken(),
      },
    });
    if (!res.ok) throw new Error(`Glitch projects single purpose tokens terminal response ${res.status} not ok`);
    const body = await res.json();
    console.log(`https://api.glitch.com/console/${body.token}/`);
  } else {
    console.log(`https://glitch.com/edit/console.html?${project.id}`);
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
    if (!res.ok) throw new Error(`Glitch projects single purpose tokens devtools response ${res.status} not ok`);
    const body = await res.json();
    console.log(`devtools://devtools/bundled/inspector.html?ws=api.glitch.com:80/project/debugger/${body.token}`);
  } else {
    console.log(`https://glitch.com/edit/debugger.html?${project.id}`);
  }
}

async function doConsoleAddMe(opts) {
  const {user} = await boot();
  console.log(`await application.glitchApi().v0.createProjectPermission(application.currentProject().id(), ${JSON.stringify(user.id)}, ${JSON.stringify(ACCESS_LEVEL_MEMBER)});`);
}

commander.program.name('snail');
commander.program.version(packageMeta.version);
commander.program.description(`CLI for Glitch
https://snail-cli.glitch.me/`);
const cmdAuth = commander.program
  .command('auth')
  .description('sign in');
cmdAuth
  .command('anon')
  .description('create a new anonymous user')
  .action(doAuthAnon);
cmdAuth
  .command('send-email [email]')
  .description('request a sign-in code over email')
  .option('-i, --interactive', 'additionally prompt for code and complete sign-in')
  .addHelpText('after', `
Use the code in the email with snail auth code to authenticate.`)
  .action(doAuthSendEmail);
cmdAuth
  .command('code [code]')
  .description('authenticate with sign-in code')
  .addHelpText('after', `
Request a code on the web or with snail auth send-email.`)
  .action(doAuthCode);
cmdAuth
  .command('password [email] [password]')
  .description('authenticate with email address and password')
  .action(doAuthPassword);
commander.program
  .command('whoami')
  .description('show user login')
  .option('-n, --numeric', 'show user ID instead of login')
  .action(doWhoami);
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
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .addHelpText('after', `
Limitations:
Command line and output are not binary safe.
No output is returned until the process exits.`)
  .action(doExec);
commander.program
  .command('term [command...]')
  .alias('t')
  .description('connect to a project terminal')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--no-set-transports', 'do not set a custom list of socket.io transports')
  .option('--no-raw', 'do not alter stdin tty mode')
  .addHelpText('after', `
If command is provided, additionally sends that right after connecting.

Projects may go to sleep quickly when it only has a terminal connection open.
Using snail ot status creates an OT connection, which is what normally prevents
this when editing on the web.`)
  .action(doTerm);
commander.program
  .command('pipe <command...>')
  .description('run a command and transfer binary data to and from it')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--no-set-transports', 'do not set a custom list of socket.io transports')
  .option('--debug', 'show unrecognized lines from terminal session')
  .addHelpText('after', `
Examples:
    # Download a file
    snail pipe 'cat .data/omni.db' >omni.db
    # Upload a file
    snail pipe 'cat >.data/omni.db' <omni.db

Implementation problems:
There is no backpressure, on either side. Snail will grow in memory when there
is more data on stdin than the network can send. The WeTTY server will grow in
memory when there is more data on stdout than the network can receive. Restart
the project container (snail stop) to reclaim memory from WeTTY. Data is
transferred in base64 due to the terminal API supporting UTF-8 only, which is
inefficient.`)
  .action(doPipe);
commander.program
  .command('rsync <args...>')
  .description('launch rsync with snail pipe as the transport')
  .addHelpText('after', `
Use -- to separate options meant for snail from options meant for rsync.

Examples:
    # Download the contents of a directory
    snail rsync -- -aP my-domain:notes/ notes
    # Upload the contents of a directory
    snail rsync -- -aP notes/ my-domain:notes`)
  .action(doRsync);
commander.program
  .command('rsync-rsh <args...>', {hidden: true})
  .action(doRsyncRsh);
const cmdSsh = commander.program
  .command('ssh')
  .description('interact over SSH');
cmdSsh
  .command('copy-id <fake_host>')
  .description('add a local public key to authorized keys in project')
  .option('-i <identity_file>', 'specify which public key file')
  .addHelpText('after', `
This is like ssh-copy-id. It's not as intelligent though. It unconditionally
adds the public key without trying to authenticate first. Also it does not
support ssh-agent.

The fake_host is the project domain, optionally followed by a dot and
additional labels, which Snail ignores.`)
  .action(doSshCopyId);
cmdSsh
  .command('keyscan <fake_host>')
  .description('get host keys from project for local known hosts list')
  .addHelpText('after', `
This is like ssh-keyscan.

The fake_host is the project domain, optionally followed by a dot and
additional labels, which Snail ignores.

Example:
    snail ssh keyscan lapis-empty-cafe.snail >>~/.ssh/known_hosts`)
  .action(doSshKeyscan);
cmdSsh
  .command('proxy <fake_host>')
  .description('set up an SSH daemon and connect to it')
  .addHelpText('after', `
Use this in an SSH ProxyCommand option.

The fake_host is the project domain, optionally followed by a dot and
additional labels, which Snail ignores.

Example:
    # In ~/.ssh/config
    Host *.snail
    User app
    ProxyCommand snail ssh proxy %h
    RequestTTY no
    # Then
    ssh my-domain.snail ls

Implementation problems:
Pseudo-terminal allocation is broken, because the daemon insists on trying to
chown the pty device, which it isn't permitted to do. That makes it not very
friendly for interactive terminal use, but it should work for file transfer,
port forwarding, and programmatic access.`)
  .action(doSshProxy);
commander.program
  .command('logs')
  .description('watch application logs')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-a, --all', 'show non-application logs too, as well as all fields')
  .action(doLogs);
commander.program
  .command('stop')
  .description('stop project container')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doStop);
commander.program
  .command('download')
  .description('download project as tarball')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-o, --output <path>', 'output file location (uses server suggestion if not set)')
  .addHelpText('after', `
Pass - as path to write to stdout.`)
  .action(doDownload);
const cmdAsset = commander.program
  .command('asset')
  .alias('a')
  .description('manage CDN assets');
cmdAsset
  .command('policy')
  .description('provision an S3 POST policy for asset upload')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-t, --type <type>', 'asset MIME type', 'application/octet-stream')
  .action(doAPolicy);
cmdAsset
  .command('push <src>')
  .description('upload an asset')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-n, --name <name>', 'destination filename (taken from src if not set)')
  .option('-t, --type <type>', 'asset MIME type', 'application/octet-stream')
  .option('-a, --max-age <age_seconds>', 'max-age for Cache-Control', 31536000)
  .addHelpText('after', `
Implementation problems:
Does not maintain .glitch-assets.`)
  .action(doAPush);
cmdAsset
  .command('cp <src> <dst>')
  .description('copy an asset')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .addHelpText('after', `
Copy an asset from URL or name src to a new name dst.

Examples:
    # Copy from full URL
    snail a cp https://cdn.glitch.global/8e6cdc77-20b9-4209-850f-d2607eeae33a/my-asset.png?v=1622356099641 avatar.png
    # Copy asset from current project
    snail a cp my-asset.png avatar.png

Implementation problems:
Does not maintain .glitch-assets.`)
  .action(doACp);
const cmdOt = commander.program
  .command('ot')
  .description('interact over OT');
cmdOt
  .command('push <src> <dst>')
  .description('transfer local file src to project file dst')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .addHelpText('after', `
Pass - as src to read from stdin.`)
  .action(doOtPush);
cmdOt
  .command('pull <src> <dst>')
  .description('transfer project file src to local file dst')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .addHelpText('after', `
Pass - as dst to write to stdout.`)
  .action(doOtPull);
cmdOt
  .command('mv <src> <dst>')
  .description('move or rename a document')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .action(doOtMv);
cmdOt
  .command('rm <path>')
  .description('unlink a document')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .action(doOtRm);
cmdOt
  .command('ls <path>')
  .description('list a document\'s children')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .action(doOtLs);
cmdOt
  .command('request-join')
  .description('request to join')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .option('-r, --random-name', 'send request under a randomly generated name')
  .action(doOtRequestJoin);
cmdOt
  .command('status')
  .description('watch container resource statistics')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .action(doOtStatus);
commander.program
  .command('hours')
  .description('show project hours usage')
  .action(doHours);
const cmdProject = commander.program
  .command('project')
  .description('manage projects');
cmdProject
  .command('create [domain]')
  .description('create a project')
  .option('-r, --remix <domain>', 'specify base project (glitch-hello-node if not set)')
  .option('--remote', 'attempt to set up the glitch git remote')
  .addHelpText('after', `
Creates a new project and shows its domain. Leave domain unset to get a
randomly generated project domain.

Implementation problems:
Does not send a reCAPTCHA response. This won't work on anonymous accounts.`)
  .action(doProjectCreate);
cmdProject
  .command('info')
  .description('show information about a project')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doProjectInfo);
cmdProject
  .command('update')
  .description('update a project\'s metadata')
  .option('-p, --project <domain>', 'specify which project')
  .option('--domain <new_domain>', 'set new domain')
  .option('--description <description>', 'set description')
  .option('--private', 'set legacy private flag (deprecated)')
  .option('--no-private', 'clear legacy private flag (deprecated)')
  .option('--privacy <privacy>', 'set privacy (public, private_code, or private_project)')
  .action(doProjectUpdate);
cmdProject
  .command('delete')
  .description('delete a project')
  .option('-p, --project <domain>', 'specify which project')
  .action(doProjectDelete);
cmdProject
  .command('undelete')
  .description('undelete a project')
  .option('-p, --project <domain>', 'specify which project')
  .action(doProjectUndelete);
cmdProject
  .command('list')
  .description('list projects')
  .option('-d, --deleted', 'list deleted projects')
  .action(doProjectList);
const cmdMember = commander.program
  .command('member')
  .description('manage project members');
cmdMember
  .command('add <login>')
  .description('add a member')
  .option('-p, --project <domain>', 'specify which project')
  .option('-n, --numeric', 'specify user ID instead of login')
  .action(doMemberAdd);
cmdMember
  .command('rm <login>')
  .description('remove a member')
  .option('-p, --project <domain>', 'specify which project')
  .option('-n, --numeric', 'specify user ID instead of login')
  .action(doMemberRm);
cmdMember
  .command('leave')
  .description('leave the project')
  .option('-p, --project <domain>', 'specify which project')
  .action(doMemberLeave);
cmdMember
  .command('list')
  .description('list members')
  .option('-p, --project <domain>', 'specify which project')
  .action(doMemberList);
const cmdDomain = commander.program
  .command('domain')
  .description('manage custom domains');
cmdDomain
  .command('add <domain>')
  .description('add a custom domain')
  .option('-p, --project <domain>', 'specify which project')
  .action(doDomainAdd);
cmdDomain
  .command('rm <domain>')
  .description('remove a custom domain')
  .option('-p, --project <domain>', 'specify which project')
  .action(doDomainRm);
cmdDomain
  .command('list')
  .description('list custom domains')
  .option('-p, --project <domain>', 'specify which project')
  .action(doDomainList);
const cmdWeb = commander.program
  .command('web')
  .description('display web URLs');
cmdWeb
  .command('app')
  .description('display application URL')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doWebApp);
cmdWeb
  .command('details')
  .description('display project details URL')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doWebDetails);
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
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-c, --cap', 'display devtool URL with debugger token')
  .addHelpText('after', `
Implementation problems:
Does not set GLITCH_DEBUGGER. Do that yourself (snail setenv GLITCH_DEBUGGER
true).`)
  .action(doWebDebugger);
const cmdConsole = commander.program
  .command('console')
  .description('generate snippets for running in the developer console');
cmdConsole
  .command('add-me')
  .description('generate snippet to add this user to a project')
  .action(doConsoleAddMe);

commander.program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Local Variables:
// indent-tabs-mode: nil
// js-indent-level: 2
// End:

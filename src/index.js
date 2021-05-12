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
  if (!persistentToken) throw new Error(`Persistent token unset. Save (${path.join(os.homedir(), '.config', 'snail', 'persistent-token')}) or set in environment (G_PERSISTENT_TOKEN)`);
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
          const {resolve, reject} = this.masterRequested;
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
          const {resolve, reject} = this.docRequested[doc.docId];
          delete this.docRequested[doc.docId];
          resolve(doc);
          break;
        }
        case 'accepted-oplist': {
          const opList = msg.opList;
          const {resolve, reject} = this.opListRequested[opList.id];
          delete this.opListRequested[opList.id];
          this.version = opList.version + 1;
          resolve();
          break;
        }
        case 'rejected-oplist': {
          const opList = msg.opList;
          const {resolve, reject} = this.opListRequested[opList.id];
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

async function doAuthSendEmail(email) {
  const res = await fetch('https://api.glitch.com/v1/auth/email/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      emailAddress: email,
    }),
  });
  if (!res.ok) throw new Error(`Glitch auth email response ${res.status} not ok`);
}

async function doAuthCode(code) {
  await failIfPersistentTokenSaved();

  const res = await fetch(`https://api.glitch.com/v1/auth/email/${code}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Glitch auth email response ${res.status} not ok`);
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
  if (!res.ok) throw new Error(`Glitch v0 setenv response ${res.status} not ok`);
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
    process.stdout.write(body.stdout);
    process.stderr.write(body.stderr);
  } else if (res.status === 500) {
    const body = await res.json();
    process.stdout.write(body.stdout);
    process.stderr.write(body.stderr);
    process.exitCode = body.signal || body.code;
  } else {
    throw new Error(`Glitch v0 exec response ${res.status} not ok`);
  }
}

async function doTerm(command, opts) {
  const io = require('socket.io-client');

  let done = false;
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
    if (!done || reason !== 'io client disconnect') {
      console.error(`Glitch console disconnected: ${reason}`);
      process.exit(1);
    }
  });
  socket.on('error', (e) => {
    console.error(e);
  });
  socket.once('login', () => {
    if (opts.raw) {
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

  function shellWord(s) {
    return '\'' + s.replace(/'/g, '\'"\'"\'') + '\'';
  }

  // see pipe-wrap.js
  const WRAPPER_SRC = 'var e="base64",n="data",t="end",o="\\n",r=process,{stdin:s,stdout:i}=r,a=i.write.bind(i),d=require("child_process").spawn(r.argv[1],{stdio:"pipe",shell:!0}),{stdin:p,stdout:c,stderr:l}=d,u=setInterval((()=>{a("p\\n")}),4e3),f="";s.setRawMode(!0),s.setEncoding("ascii"),s.on(n,(n=>{var t=(f+n).split(o);for(var r of(f=t.pop(),t))r?p.write(Buffer.from(r,e)):p.end()})),a("s\\n"),c.on(n,(n=>{a("o"+n.toString(e)+o)})),c.on(t,(()=>{a("O\\n")})),l.on(n,(n=>{a("e"+n.toString(e)+o)})),l.on(t,(()=>{a("E\\n")})),d.on("exit",((e,n)=>{a("r"+(n?1:e)+o),clearTimeout(u),s.pause()}));';

  let stdinStarted = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let returned = false;
  let recvBuf = '';

  let done = false;
  const socket = io('https://api.glitch.com', {
    path: `/${await getProjectDomain(opts)}/console/${await getPersistentToken()}/socket.io`,
  });

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
          process.stdin.pause();
          process.exitCode = +part.slice(1);
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
  socket.once('logout', () => {
    done = true;
    socket.close();
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
      if (msg.process === 'application') {
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
  if (!res.ok) throw new Error(`Glitch stop response ${res.status} not ok`);
}

async function doDownload(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const res = await fetch(`https://api.glitch.com/project/download/?authorization=${await getPersistentToken()}&projectId=${project.id}`);
  if (!res.ok) throw new Error(`Glitch download response ${res.status} not ok`);
  let dst;
  if (opts.output === '-') {
    dst = process.stdout;
  } else {
    let path;
    if (opts.output) {
      path = opts.output;
    } else {
      path = /attachment; filename=([\w-]+.tgz)/.exec(res.headers.get('Content-Disposition'))[1];
    }
    dst = fs.createWriteStream(path);
  }
  res.body.pipe(dst);
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

async function doAPush(src, opts) {
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
  const key = keyPrefix + (opts.name || path.basename(src));
  const form = new FormData();
  form.append('key', key);
  form.append('Content-Type', opts.type);
  form.append('Cache-Control', `max-age=${opts.maxAge}`);
  form.append('AWSAccessKeyId', body.accessKeyId);
  form.append('acl', acl);
  form.append('policy', body.policy);
  form.append('signature', body.signature);
  form.append('file', fs.createReadStream(src));
  // node-fetch is variously annoying about how it sends FormData
  // https://github.com/node-fetch/node-fetch/pull/1020
  const uploadRes = await util.promisify(form.submit).call(form, `https://s3.amazonaws.com/${bucket}`);
  if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) throw new Error(`S3 upload response ${uploadRes.statusCode} not ok`);
  console.log(`https://cdn.glitch.com/${encodeURIComponent(key)}?v=${Date.now()}`);
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
        const {resolve, reject} = inviteRequested;
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

      const timeD = new Date(msg.payload.timeNs / 1000000);
      const timeCol = timeD.toLocaleTimeString().padStart(11);
      const memoryP = (msg.payload.memoryUsage / msg.payload.memoryLimit * 100).toFixed(0).padStart(3);
      const memoryUsageM = (msg.payload.memoryUsage / (1 << 20)).toFixed(0).padStart(3);
      const memoryLimitM = (msg.payload.memoryLimit / (1 << 20)).toFixed(0).padStart(3);
      const diskP = (msg.payload.diskUsage / msg.payload.diskSize * 100).toFixed(0).padStart(3);
      const diskUsageM = (msg.payload.diskUsage / (1 << 20)).toFixed(0).padStart(3);
      const diskSizeM = (msg.payload.diskSize / (1 << 20)).toFixed(0).padStart(3);
      const cpuP = ((msg.payload.quotaUsagePercent || 0) * 100).toFixed(0).padStart(3);
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
  const fromDomain = opts.remix || 'hello-express';
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

async function doProjectList(opts) {
  const {user} = await boot();
  const persistentToken = await getPersistentToken();

  console.log('Domain                                  Privacy          App type          Last edited  Description');
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
      accessLevel: 20,
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
  if (!res.ok) throw new Error(`Glitch projects users response ${res.status} not ok`);
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
  if (!res.ok) throw new Error(`Glitch projects users response ${res.status} not ok`);
}

async function doMemberList(opts) {
  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);
  const idParams = project.permissions.map((permission) => `id=${permission.userId}`).join('&');
  const res = await fetch(`https://api.glitch.com/v1/users/by/id?${idParams}`);
  if (!res.ok) throw new Error(`Glitch users by id response ${res.status} not ok`);
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
const cmdAuth = commander.program
  .command('auth')
  .description('authenticate');
cmdAuth
  .command('anon')
  .description('create a new anonymous user')
  .action(doAuthAnon);
cmdAuth
  .command('send-email <email>')
  .description('request a sign in code over email')
  .addHelpText('after', `
Use the code in the email with snail auth code to authenticate.`)
  .action(doAuthSendEmail);
cmdAuth
  .command('code <code>')
  .description('authenticate with sign in code')
  .addHelpText('after', `
Request a code on the web or with snail auth send-email.`)
  .action(doAuthCode);
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
  .addHelpText('after', `
Limitations:
Command line and output are not binary safe.
No output is returned until the process exits.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .action(doExec);
commander.program
  .command('term [command...]')
  .alias('t')
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--no-raw', 'do not alter stdin tty mode')
  .description('connect to a project terminal')
  .addHelpText('after', `
If command is provided, additionally sends that right after connecting.`)
  .action(doTerm);
commander.program
  .command('pipe <command...>')
  .description('run a command and transfer binary data to and from it')
  .addHelpText('after', `
Examples:
    # Download a file
    snail pipe 'cat .data/omni.db' >omni.db
    # Upload a file
    snail pipe 'cat >.data/omni.db' <omni.db

Implementation problems:
There is no backpressure, on either side. snail will grow in memory when there
is more data on stdin than the network can send. The WeTTY server will grow in
memory when there is more data on stdout than the network can receive. Restart
the project container with (snail stop) to reclaim memory from WeTTY. Data is
transferred in base64 due to the terminal API supporting UTF-8 only, which is
inefficient.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show unrecognized lines from terminal session')
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
  .addHelpText('after', `
Pass - as path to write to stdout.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-o, --output <path>', 'output file location (uses server suggestion if not set)')
  .action(doDownload);
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
  .command('push <src>')
  .description('upload an assset')
  .addHelpText('after', `
Implementation problems:
Does not maintain .glitch-assets.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('-n, --name <name>', 'destination filename (taken from src if not set)')
  .option('-t, --type <type>', 'asset MIME type', 'application/octet-stream')
  .option('-a, --max-age <age_seconds>', 'max-age for Cache-Control', 31536000)
  .action(doAPush);
const cmdOt = commander.program
  .command('ot')
  .description('interact over OT');
cmdOt
  .command('push <src> <dst>')
  .description('transfer local file src to project file dst')
  .addHelpText('after', `
Pass - as src to read from stdin.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
  .action(doOtPush);
cmdOt
  .command('pull <src> <dst>')
  .description('transfer project file src to local file dst')
  .addHelpText('after', `
Pass - as dst to write to stdout.`)
  .option('-p, --project <domain>', 'specify which project (taken from remote if not set)')
  .option('--debug', 'show OT messages')
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
  .addHelpText('after', `
Creates a new project and shows its domain. Leave domain unset to get a
randomly generated project domain.

Implementation problems:
Does not send a reCAPTCHA response. This won't work on anonymous accounts.`)
  .option('-r, --remix <domain>', 'specify base project (hello-express if not set)')
  .action(doProjectCreate);
cmdProject
  .command('update')
  .description('update a project')
  .option('-p, --project <domain>', 'specify which project')
  .option('--domain <new_domain>', 'set new domain')
  .option('--description <description>', 'set description')
  .option('--private', 'set legacy private flag (deprecated)')
  .option('--no-private', 'clear legacy private flag (deprecated)')
  .option('--privacy <privacy>', 'set privacy (public, private_code, or private_project)')
  .action(doProjectUpdate);
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

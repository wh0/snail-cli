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
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (this.opts.debug) {
        console.error('<', util.inspect(msg, {depth: null, colors: true}));
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
          docId: docId,
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
    if ('code' in e && e.code === 'ENOENT') {
      return dst;
    } else {
      throw e;
    }
  }
  if (dstStats.isDirectory()) {
    return path.join(dst, name);
  } else {
    return dst;
  }
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
    throw new Error(`Glitch exec response ${res.status} not ok`);
  }
}

async function doTerm(opts) {
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
    if (opts.c) {
      socket.emit('input', opts.c.join(' ') + '\n');
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

async function doTPipe(command, opts) {
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
  if (dst !== '-') {
    dst = await guessSingleDestination(dst, srcNames[srcNames.length - 1]);
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
        const doc = await otResolveExisting(c, srcNames);

        done = true;
        ws.close();

        otRequireNotDir(doc);
        if ('base64Content' in doc) {
          if (dst === '-') {
            process.stdout.write(doc.base64Content, 'base64');
          } else {
            await fs.promises.writeFile(dst, doc.base64Content, 'base64');
          }
        } else {
          if (dst === '-') {
            process.stdout.write(doc.content);
          } else {
            await fs.promises.writeFile(dst, doc.content);
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

async function doOtRm(path, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const names = path.split('/');

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

async function doOtLs(path, opts) {
  const WebSocket = require('ws');

  const projectDomain = await getProjectDomain(opts);
  const project = await getProjectByDomain(projectDomain);

  const names = path.split('/');

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

const WebSocket = require('ws');

let version = 0;
const cache = new Map();
function receiveDocument(doc) {
  console.log('%%%%%% receive document', doc.docId);
  cache.set(doc.docId, doc);
}

const ws = new WebSocket(`wss://api.glitch.com/${process.env.G_PROJECT_ID}/ot?authorization=${process.env.G_PERSISTENT_TOKEN}`);
ws.on('error', (e) => {
  console.error(e);
});
ws.on('close', (code, reason) => {
  console.error('Socket closed', code, reason);
  process.exit(1);
});

let currentId = 'root';
const nextPaths = ['.', 'index.html'];
function advance() {
  while (true) {
    const doc = cache.get(currentId);
    if (!doc) {
      console.log('%%%%%% > register document', currentId);
      ws.send(JSON.stringify({
        type: 'register-document',
        docId: currentId,
      }));
      return;
    }
    if (!nextPaths.length) {
      console.log('%%%%%% here it is', doc);
      process.exit(0);
    }
    if (doc.docType !== 'directory') {
      console.error(`${currentId} is not a directory`);
      process.exit(1);
    }
    const token = nextPaths.shift();
    if (!(token in doc.children)) {
      console.error(`${currentId} has no child ${token}`);
      process.exit(1);
    }
    const childId = doc.children[token].docId;
    console.log('%%%%%%', currentId, '--', token, '->', childId);
    currentId = childId;
  }
}

ws.on('message', (data) => {
  console.log('%%%%%% < message', data);
  const msg = JSON.parse(data);
  switch (msg.type) {
    case 'master-state':
      version = msg.state.version;
      receiveDocument(msg.state.documents['root']);
      receiveDocument(msg.state.documents[cache.get('root').children['.']]);
      // Other documents are stripped, and we can't use them.
      advance();
      break;
    case 'register-document':
      receiveDocument(msg.document);
      advance();
      break;
  }
});

ws.on('open', () => {
  // console.log('%%% > master state');
  // ws.send(JSON.stringify({
  //   type: 'master-state',
  //   clientId: 'g000000000000000',
  // }));
  advance();
});

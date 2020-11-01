const WebSocket = require('ws');

class SOtClient {
  constructor(projectId) {
    this.ws = new WebSocket(`wss://api.glitch.com/${projectId}/ot?authorization=${process.env.G_PERSISTENT_TOKEN}`);
    this.version = 0;
    this.promised = {};
    this.requested = {};
    this.ws.on('message', (data) => {
      console.log('%%%%%% < message', data);
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'register-document':
          const doc = msg.document;
          const children = doc.children;
          doc.children = {};
          for (const k in children) {
            doc.children[k] = children[k].docId;
          }
          const {resolve, reject} = this.requested[doc.docId];
          delete this.requested[doc.docId];
          resolve(doc);
          break;
      }
    });
  }
  async fetchDoc(docId) {
    if (!(docId in this.promised)) {
      this.promised[docId] = new Promise((resolve, reject) => {
        this.requested[docId] = {resolve, reject};
        console.log('%%%%%% > register document', docId);
        this.ws.send(JSON.stringify({
          type: 'register-document',
          docId: docId,
        }));
      });
    }
    return this.promised[docId];
  }
  async resolvePath(names) {
    let doc = await this.fetchDoc('root');
    doc = await this.fetchDoc(doc.children['.']);
    for (const name of names) {
      if (doc.docType !== 'directory') throw new Error(`${doc.docId} is not a directory`);
      if (name === '' || name === '.') continue;
      if (!(name in doc.children)) throw new Error(`${name} not found in ${doc.docId}`);
      doc = await this.fetchDoc(doc.children[name]);
    }
    return doc;
  }
}

const c = new SOtClient(process.env.G_PROJECT_ID);
c.ws.on('error', (e) => {
  console.error(e);
});
c.ws.on('close', (code, reason) => {
  console.error('%%%%%% socket closed', code, reason);
  process.exit(1);
});
c.ws.on('open', () => {
  console.log('%%% open');
  (async function () {
    try {
      const doc = await c.resolvePath(['index.html']);
      console.log('%%%%%% resolved', doc);
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
});

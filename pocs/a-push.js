const fs = require('fs');
const path = require('path');

const fetch = require('node-fetch');
const FormData = require('form-data');

(async function () {
  try {
    const filename = path.basename(process.argv[2]);
    // ugh our libraries can't figure out the content-length from a stream. read it into memory for now
    // const content = fs.createReadStream(process.argv[2]);
    const content = await fs.promises.readFile(process.argv[2]);
    const res = await fetch(`https://api.glitch.com/v1/projects/${process.env.G_PROJECT_ID}/policy`, {
      headers: {
        'Authorization': process.env.G_PERSISTENT_TOKEN,
      },
    });
    console.log(res);
    console.log(res.headers);
    if (!res.ok) throw new Error('response not ok ' + res.status)
    const body = await res.json();
    console.log(body);
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
    const form = new FormData();
    form.append('key', keyPrefix + filename);
    form.append('Content-Type', 'application/octet-stream');
    form.append('Cache-Control', 'max-age=31536000');
    form.append('AWSAccessKeyId', body.accessKeyId);
    form.append('acl', acl);
    form.append('policy', body.policy);
    form.append('signature', body.signature);
    form.append('file', content);
    const res2 = await fetch(`https://s3.amazonaws.com/${bucket}`, {
      method: 'POST',
      body: form,
    });
    console.log(res2, await res2.text()); // %%%
  } catch (e) {
    console.error(e);
  }
})();

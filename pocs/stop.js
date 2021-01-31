const fetch = require('node-fetch');

(async function () {
  try {
    const res = await fetch(`https://api.glitch.com/v1/projects/${process.env.G_PROJECT_ID}/stop`, {
      method: 'POST',
      headers: {
        'Authorization': process.env.G_PERSISTENT_TOKEN,
        // 'Content-Type': 'application/json',
      },
    });
    console.log(res);
    console.log(res.headers);
    if (!res.ok) throw new Error('response not ok ' + res.status);
    const body = await res.text();
    console.log(body);
  } catch (e) {
    console.error(e);
  }
})();

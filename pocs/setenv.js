const fetch = require('node-fetch');

(async function () {
  try {
    const res = await fetch(`https://api.glitch.com/projects/${process.env.G_PROJECT_DOMAIN}/setenv`, {
      method: 'POST',
      headers: {
        'Authorization': process.env.G_PERSISTENT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        env: {
          CLIENT_TIME: '' + Date.now(),
        },
      }),
    });
    console.log(res);
    console.log(res.headers);
    if (!res.ok) throw new Error('response not ok ' + res.status);
    const body = await res.json();
    console.log(body);
  } catch (e) {
    console.error(e);
  }
})();

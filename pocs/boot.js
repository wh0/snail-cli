const fetch = require('node-fetch');

(async function () {
  try {
    const res = await fetch('https://api.glitch.com/boot?latestProjectOnly=true', {
      headers: {
        'Authorization': process.env.G_PERSISTENT_TOKEN,
      },
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

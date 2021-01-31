const fetch = require('node-fetch');

const base_project_id = '33ebcb39-397a-4ab9-bc6a-868aeb7914e1'; // empty-glitch

(async function () {
  try {
    // POST v1/projects gets 404? oh well, frontend only uses remix
    const res = await fetch(`https://api.glitch.com/v1/projects/${base_project_id}/remix`, {
      method: 'POST',
      headers: {
        'Authorization': process.env.G_PERSISTENT_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // env
        recaptcha: '03AGdBq26J7FMAVjDs12RlK_1tjukp0-1FuG7EKI1w94cIkzX844IczKHku1a3YDtxV-6FF8v_8PA5vduRTzAjaQ_pFFAYto_tFspOpas3AjLbpOBLhTRGkx5nuYDToZEqIJq1orMXyPocsJW1Zq4B0_d-r-zqloX9eWQ7CufKy6SErj4_Lq9ECytGbRqeyv02cuAChA5vLXSy3VnuAXyuida4Awgv_kYEwAQBQqKH2NQHLSJIIARbQTSeUelaDCmsCALJe0E5IewKf33_qJWexc4YL_in3n68_WVLtv3BFqXWRZlNYkM5HhWJ8mJ7DXoO7zzFQOANRHmJG3eJoDS_u6mmUexhnyxGwBPFAr-vaTqt7888mUXzHej4MsU4dx1-TS59HIBBKYhIE_1FRfmo7lJR6QB6FXISbWDQC4mAYoNIZLwpscHXIwhXOlImOf8yJ2tiky872ju8CfWNhdp2ypvEpQMX64RheBGBbAsuw-kiuF0-9bdFm7VtNq0ylXD_9zYnYnyj4pFXtGANKO83JVHAHiSmmOlo7w',
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

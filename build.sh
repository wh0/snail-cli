#!/bin/sh -eux
webpack --json >dist/stats.json
{
  head -n1 src/index.js
  cat dist/main.js
} >dist/snail.js
chmod +x dist/snail.js

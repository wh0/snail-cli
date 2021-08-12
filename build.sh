#!/bin/sh -eux
webpack -c webpack.config.js
{
  head -n1 src/index.js
  cat dist/main.js
} >dist/snail.js
chmod +x dist/snail.js

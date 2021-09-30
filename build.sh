#!/bin/sh -eux
webpack
{
  head -n1 src/index.js
  cat dist/main.js
} >dist/snail.js
chmod +x dist/snail.js

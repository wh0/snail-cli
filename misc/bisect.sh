#!/bin/sh -eu

# Find the largest file size that can be served from cdn.glitch.global.

# one higher than highest known ok size
low=0
# one lower than lowest known failing size
high=24000000
while true; do
  if [ "$low" -gt "$high" ]; then
    # when the cross over, we know the exact boundary, with
    # high = highest ok size; and
    # low = lowest failing size
    break
  fi
  guess=$(((low + high) / 2))
  echo >&2 "low $low high $high guess $guess"
  echo >&2 -n "generating "
  head "-c$guess" /dev/zero >/tmp/zeros.dat
  echo >&2 -n "uploading "
  url=$(snail a push -p "$POCS_PROJECT_DOMAIN" /tmp/zeros.dat)
  # force cdn.glitch.global
  url_glitch_global=$(echo "$url" | sed s/cdn\\.glitch\\.me/cdn.glitch.global/)
  echo >&2 -n "downloading "
  if curl -fLIs "$url_glitch_global" >/dev/null; then
    echo >&2 "ok"
    low=$((guess + 1))
  else
    echo >&2 "fail"
    high=$((guess - 1))
  fi
done
echo "$high"

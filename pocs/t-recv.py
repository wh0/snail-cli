import base64
import sys

with open(3, "wb") as dst:
  print("snail_start")
  for line in sys.stdin:
    print(".")
    if line == "\\n":
      break
    chunk = base64.b64decode(line)
    dst.write(chunk)
  print("snail_end")

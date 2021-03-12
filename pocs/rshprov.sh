#!/bin/sh -eux
host=$1
shift
exec snail pipe -p "$host" -- "$@"

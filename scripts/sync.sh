#!/bin/sh
exec node "$(dirname "$0")/agent-config.mjs" sync "$@"

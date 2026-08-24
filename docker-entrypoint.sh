#!/bin/sh
# Runs as root before dropping to the unprivileged "app" user. Needed
# because /app/server/uploads is a mounted volume -- the ownership baked
# into the image at build time only applies to a *fresh* volume; an
# existing volume (e.g. one created before the app started running as a
# non-root user) keeps whatever ownership it already had on disk, which
# would leave the app user unable to write new photo/avatar uploads.
set -e
chown -R app:app /app/server/uploads
exec su-exec app "$@"

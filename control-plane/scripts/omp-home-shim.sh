#!/bin/sh
# Point omp at an OMP home carried in on the workspace mount.
#
# The container backend runs `<runtime> exec -i <id> omp acp`, and the only
# things it injects at run time are the image, the workspace bind mount, and
# OMPD_REPO / OMPD_REF. There is no flag for "give the container credentials",
# so the workspace is the only channel: the daemon mounts it at the same
# absolute path it has on the host and sets it as the container's workdir, and
# `docker exec` inherits that workdir.
#
# So an OMP home seeded at `<workspace>/.omp-home` is picked up here. That is a
# security fact, not a convenience: every credential in it is readable by
# anything running in the container, and by anything that can write to the
# workspace on the host.
#
# Absent, omp runs against the image's own HOME and has no credentials. That is
# left alone rather than refused, because `omp --version` and any other local
# check has to keep working, and the failure surfaces loudly at the first model
# call. A seed that is present but has no `.omp` in it is different: someone
# meant to pass credentials and the wiring is wrong, so that one is refused
# rather than quietly downgraded to the image's config.
set -eu

SEED="$PWD/.omp-home"
if [ -d "$SEED" ]; then
  if [ ! -d "$SEED/.omp" ]; then
    echo "omp shim: $SEED exists but holds no .omp; refusing to fall back to the image's HOME" >&2
    exit 78
  fi
  # Under /tmp because that is the one writable filesystem a hardened container
  # host has: the root filesystem is mounted read-only and the scratch root is
  # a tmpfs. `mktemp -d` rather than a fixed path so nothing already sitting
  # there can be followed, since /tmp is shared and world-writable.
  HOME="$(mktemp -d /tmp/omp-home.XXXXXXXX)"
  export HOME
  # Copied rather than used in place, for two reasons. The seed is a bind mount
  # from the daemon's machine, so an ACP host that refreshed a credential in
  # place would be writing the operator's own OMP home. And omp keeps its state
  # in SQLite, whose locking is not dependable over a virtiofs mount.
  cp -a "$SEED/." "$HOME/"
  chmod -R go-rwx "$HOME"
fi

exec /usr/local/lib/omp/omp "$@"

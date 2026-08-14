# A container image that can serve as an ompd container host.
#
# Built by `scripts/check-container-host.ts`, which downloads the omp release
# for the container's architecture into the build context first. The binary is
# not in the repo: it is 150MB and versioned by whoever built the image.
#
# Debian rather than Alpine because the omp release is a glibc build, and
# slim rather than full because the only thing missing from it is a root
# certificate store.
FROM debian:bookworm-slim

# omp reaches a model over TLS and debian-slim ships no CA bundle, so every
# request would fail certificate verification. The gate wrapper's far side
# needs mkdir, chmod, tee and cat, all of which are already in coreutils.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY omp /usr/local/lib/omp/omp
COPY omp-home-shim.sh /usr/local/bin/omp
RUN chmod 0555 /usr/local/lib/omp/omp /usr/local/bin/omp

ENV HOME=/root

FROM ubuntu:26.04

# Keep a real build operation active past the focused deadline. The host-side
# observer independently records both admission and the socket close caused by
# BuildKit cancellation; natural completion is a failing negative control.
SHELL ["/bin/bash", "-c"]
RUN exec 3<>/dev/tcp/host.docker.internal/18083; \
    printf 'GET /blocked-build HTTP/1.0\r\n\r\n' >&3; \
    cat <&3; \
    echo NATURAL_BUILD_COMPLETION

FROM ubuntu:26.04

# Keep a real build operation active past the focused deadline. The host-side
# observer independently records both admission and the socket close caused by
# BuildKit cancellation; natural completion is a failing negative control.
RUN exec 3<>/dev/tcp/127.0.0.1/18083; \
    printf 'GET /blocked-build HTTP/1.0\r\n\r\n' >&3; \
    cat <&3; \
    echo NATURAL_BUILD_COMPLETION

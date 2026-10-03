FROM alpine:3.22
ARG TARGETARCH
RUN apk add --no-cache zstd
COPY srv-${TARGETARCH} /delta-srv
EXPOSE 8080
ENTRYPOINT ["/delta-srv"]

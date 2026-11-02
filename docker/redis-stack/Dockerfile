# Keep the Stack modules, RedisInsight and entrypoint while patching Redis 7.4.
FROM redis/redis-stack:7.4.0-v8 AS redis-build

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates curl libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl --fail --show-error --location --proto '=https' \
      https://download.redis.io/releases/redis-7.4.12.tar.gz -o redis.tar.gz \
    && printf '%s  redis.tar.gz\n' '56588ee1648539556f2b6cf4e873e3734afbbe40fa952fec2fcd6b6d7dae2924' | sha256sum --check - \
    && tar -xzf redis.tar.gz \
    && make -C redis-7.4.12 -j2 BUILD_TLS=yes

FROM redis/redis-stack:7.4.0-v8

COPY --from=redis-build /build/redis-7.4.12/src/redis-server /opt/redis-stack/bin/redis-server
COPY --from=redis-build /build/redis-7.4.12/src/redis-cli /opt/redis-stack/bin/redis-cli
COPY --from=redis-build /build/redis-7.4.12/src/redis-check-rdb /opt/redis-stack/bin/redis-check-rdb
COPY --from=redis-build /build/redis-7.4.12/src/redis-check-aof /opt/redis-stack/bin/redis-check-aof

USER root
RUN for name in redis-server redis-cli redis-check-rdb redis-check-aof; do \
      ln -sf "/opt/redis-stack/bin/$name" "/usr/bin/$name"; \
    done \
    && redis-server --version | grep -F 'v=7.4.12'

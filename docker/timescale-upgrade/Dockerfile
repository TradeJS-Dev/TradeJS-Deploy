# Temporary migration image: update the extension on PostgreSQL 16.15 before
# switching the persistent cluster to PostgreSQL 16.16. Never use as the final
# production image; production Compose pins the released vendor image.
ARG BASE_IMAGE=timescale/timescaledb@sha256:289d55704b1b3ee8263cd3805c6930f9cd54506835a8f19f9b85dad17d5c5a8a
FROM ${BASE_IMAGE} AS build

RUN apk add --no-cache build-base cmake openssl-dev icu-dev curl
WORKDIR /build
RUN curl --fail --location --retry 3 \
      https://codeload.github.com/timescale/timescaledb/tar.gz/692795d0cf7126e816d1f30b323f24b1473d82e9 \
      --output source.tar.gz \
    && echo '190a5f6a4ceae0aafaf4c78496cdb0e72f9f1bf37a0201565ec5329de6fb933b  source.tar.gz' | sha256sum -c - \
    && tar -xzf source.tar.gz --strip-components=1 \
    && ./bootstrap -DCMAKE_BUILD_TYPE=Release -DREGRESS_CHECKS=OFF -DWARNINGS_AS_ERRORS=OFF \
    && cmake --build build --parallel 2 \
    && cmake --install build

FROM ${BASE_IMAGE}
COPY --from=build /usr/local/lib/postgresql/timescaledb*.so /usr/local/lib/postgresql/
COPY --from=build /usr/local/share/postgresql/extension/timescaledb* /usr/local/share/postgresql/extension/

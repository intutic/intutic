# ─── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM rust:1.89-slim-bookworm AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Cache dependency compilation separately from application code
COPY Cargo.toml Cargo.lock ./
# Create a dummy main to cache deps
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && echo "pub mod config;" > src/lib.rs
RUN cargo build --release 2>/dev/null || true
RUN rm -f target/release/deps/intutic_proxy* target/release/intutic-proxy

# Now copy real source and build
COPY src/ ./src/
COPY build.rs ./build.rs
COPY assets/ ./assets/
COPY benches/ ./benches/
RUN cargo build --release

# ─── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# Install runtime dependencies (OpenSSL, CA certs for HTTPS to upstream LLMs)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -u 1001 intutic
USER intutic
WORKDIR /home/intutic

# Copy compiled binary
COPY --from=builder /build/target/release/intutic-proxy /usr/local/bin/intutic-proxy

# Default config (overridden by ConfigMap mount at /etc/intutic/proxy-config.yaml)
ENV CONFIG_PATH=/etc/intutic/proxy-config.yaml
ENV PORT=4000
ENV RUST_LOG=intutic_proxy=info,tower_http=info

EXPOSE 4000

# Health check (maps to GET /health in router.rs)
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:4000/health || exit 1

ENTRYPOINT ["/usr/local/bin/intutic-proxy"]

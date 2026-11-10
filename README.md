# webhook-delivery-service

> **High-Throughput, SSRF-Resilient Distributed Webhook Dispatch Engine**

[![Node.js Version](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-Distributed_Queues-FF6B6B?style=for-the-badge)](https://docs.bullmq.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

---

## 1. Executive Architectural Overview & Key Guarantees

In modern event-driven and payment architectures, synchronous outbound HTTP notifications introduce fatal points of failure: **slow external receivers block server threads**, **intermittent network failures trigger thundering herd cascades**, and **unrestricted outbound HTTP requests leave infrastructure vulnerable to Server-Side Request Forgery (SSRF) and DNS rebinding attacks**.

`webhook-delivery-service` solves these systemic bottlenecks using a decoupled, dual-process event delivery architecture designed for mission-critical reliability:

```
┌────────────────────────────────┐         ┌────────────────────────────────┐
│   Ingestion Web Gateway        │         │   Background Delivery Worker   │
│   (npm run start)              │         │   (npm run start:worker)       │
│                                │         │                                │
│  • Express 5 + Rate Limiting   │         │  • BullMQ Consumer Pool        │
│  • Timing-Safe API Key Auth    │         │  • SSRF & Anti-Rebinding Undici│
│  • Atomic Event Fan-Out Outbox │         │  • Jittered Exponential Backoff│
│  • Non-Blocking Async Ingestion│         │  • Dead-Letter Queue (DLQ)     │
└───────────────┬────────────────┘         └────────────────┬───────────────┘
                │                                           │
                ▼                                           ▼
       ┌──────────────────┐                       ┌──────────────────┐
       │  PostgreSQL 17   │◄──────────────────────┤     Redis 7      │
       │  (Prisma Engine) │    Updates State      │ (BullMQ Streams) │
       └──────────────────┘                       └──────────────────┘
```

### Core Production Guarantees

- **At-Least-Once Delivery**: Guaranteed notification dispatch through persistent Redis streams and transactional database records.
- **Strict Ingestion Idempotency**: Database-level unique constraint enforcement (`P2002`) on `idempotencyKey` prevents duplicate event creation.
- **SSRF & Anti-DNS Rebinding Protection**: Pre-flight IP validation across all IANA RFC 6890 private/reserved ranges combined with socket-level IP-pinning via a custom Undici connector.
- **Zero-Downtime Graceful Draining**: Coordinated teardown on `SIGTERM`/`SIGINT` drains in-flight HTTP connections, completes active BullMQ jobs, and disconnects connection pools cleanly.
- **Distributed Observability**: Structured JSON logging (Pino) correlated across processes via Node.js `AsyncLocalStorage` (`requestId`, `correlationId`), paired with Prometheus `/metrics`.

---

## 2. System Architecture & Workflows

### High-Level System Architecture

```mermaid
flowchart TD
    Client["Client App / Webhook Producer"] -->|"POST /api/v1/events (with X-API-Key)"| Ingestion["Ingestion Gateway (Express 5)"]

    subgraph Ingestion_Service ["Ingestion Service Pipeline"]
        Ingestion --> RL["Rate Limiter (100 req/min)"]
        RL --> Auth["Timing-Safe API Key Validator"]
        Auth --> Trx["Prisma Transaction ($transaction)"]
        Trx -->|"1. Persist Event & Match Endpoints"| Postgres[("PostgreSQL 17 Database")]
        Trx -->|"2. Enqueue Delivery Jobs"| Redis[("Redis 7 / BullMQ Stream")]
    end

    Ingestion -->|"202 Accepted (Idempotent)"| Client

    subgraph Worker_Service ["Delivery Worker Daemon"]
        Redis -->|"Consume Job"| Worker["Delivery Worker (BullMQ)"]
        Worker --> Context["Hydrate AsyncLocalStorage Tracing Context"]
        Context --> Signer["Compute HMAC-SHA256 Payload Signature"]
        Signer --> HTTPClient["Safe Undici Client (SSRF & Socket Pinning)"]
        HTTPClient -->|"Signed POST (X-Webhook-Signature)"| Receiver["Destination Webhook Endpoint"]
        
        Receiver -->|"2xx Success"| Succeeded["Mark SUCCEEDED & Record Attempt"]
        Receiver -->|"5xx / Network Error"| RetryCheck{"Attempts < Max?"}
        Receiver -->|"4xx / SSRF Block"| DeadLetter["Mark DEAD_LETTERED (DLQ)"]

        RetryCheck -->|"Yes"| Backoff["Apply Exponential Backoff + Jitter"]
        Backoff -->|"Re-schedule Job"| Redis
        RetryCheck -->|"No (Exhausted)"| DeadLetter
        
        Succeeded --> Postgres
        DeadLetter --> Postgres
    end
```

---

### SSRF & Anti-DNS Rebinding Security Sequence

Standard HTTP clients perform DNS resolution and TCP connection independently, creating a critical vulnerability window for **Time-of-Check to Time-of-Use (TOCTOU) DNS Rebinding attacks**. The diagram below demonstrates how `webhook-delivery-service` enforces socket-level IP pinning to eliminate this attack vector:

```mermaid
sequenceDiagram
    autonumber
    participant Worker as Delivery Worker
    participant HttpClient as Safe Undici HTTP Client
    participant DNS as System DNS Resolver
    participant Target as Destination Server

    Worker->>HttpClient: Dispatch webhook (URL: https://api.partner.com/webhook)
    HttpClient->>DNS: Resolve IP addresses (A/AAAA lookup)
    DNS-->>HttpClient: Returns [203.0.113.15, 198.51.100.42]

    rect rgb(240, 248, 255)
    Note over HttpClient: Pre-Flight RFC 6890 Classification
    HttpClient->>HttpClient: Validate all resolved IPs against prohibited ranges<br/>(Loopback, Private RFC 1918, Link-Local, Multicast, CGNAT, IPv6 ULA)
    end

    alt Any IP is Private/Prohibited
        HttpClient-->>Worker: Reject immediately with SsrfSecurityError (Fail-Closed)
        Note over Worker: Route job directly to DLQ (Non-retryable)
    else All IPs are Public
        rect rgb(255, 250, 240)
        Note over HttpClient: Socket-Level IP Pinning
        HttpClient->>Target: Open TCP Socket directly to pinned IP (203.0.113.15:443)
        HttpClient->>Target: TLS Handshake with original SNI (api.partner.com)
        end
        Target-->>HttpClient: TLS Established
        HttpClient->>Target: POST payload with Host: api.partner.com & X-Webhook-Signature
        Target-->>HttpClient: 200 OK
        HttpClient-->>Worker: Delivery Successful
    end
```

---

## 3. Technical Feature Matrix & Security Engineering

| Feature | Engineering Implementation | Production Impact |
| :--- | :--- | :--- |
| **Transactional Fan-Out** | PostgreSQL `$transaction` creating `Event` + multiple `Delivery` records, then atomically enqueuing BullMQ jobs. | Eliminates partial failure state; guaranteed no lost webhooks if node crashes during ingestion. |
| **Ingestion Idempotency** | PostgreSQL unique constraint on `idempotencyKey` caught as Prisma error code `P2002`. | Prevents double-processing and duplicate event generation; returns deterministic `409 Conflict`. |
| **SSRF & Anti-DNS Rebinding** | Pre-flight RFC 6890 classification with raw IP socket pinning in Undici. Disables HTTP redirects (`maxRedirections: 0`). | Blocks access to AWS IMDS (`169.254.169.254`), GCP metadata, localhost, and internal microservices. Eliminates TOCTOU DNS race conditions. |
| **Exponential Backoff + Jitter** | Configurable retry policy with Decorrelated Jitter formula. | Prevents synchronized thundering herd spikes against downstream servers during recovery. |
| **HMAC-SHA256 Integrity** | SHA-256 HMAC digest computed over raw serialized body, passed in `X-Webhook-Signature`. | Guarantees tamper-proof payload transmission and origin authenticity for receivers. |
| **DLQ & Manual Replay** | Automatic transition to `DEAD_LETTERED` on permanent failures (4xx, SSRF, max retries) with transactional replay API. | Prevents queue poisoning; allows operations teams to inspect failed payloads and replay them safely. |
| **Timing-Safe Auth** | Constant-time string validation using Node.js `crypto.timingSafeEqual` with buffer length matching on `X-API-Key`. | Eliminates side-channel timing attack vectors on API authentication. |
| **Sliding-Window Rate Limiting** | `express-rate-limit` configured at 100 requests/min per IP with standard IETF `RateLimit-*` headers. | Protects ingestion gateway from DoS spikes and resource exhaustion. |
| **Distributed Tracing** | Node.js `AsyncLocalStorage` stores `requestId` and `correlationId`, bound to Pino and propagated in BullMQ jobs. | Full end-to-end trace correlation from HTTP ingestion to background delivery attempts. |
| **Prometheus Metrics** | Public `/metrics` exporter tracking HTTP request counts, response durations, delivery success/failure rates, and DLQ movements. | Out-of-the-box scraping for Kubernetes Prometheus Operator / Grafana dashboards. |

---

### Exponential Backoff & Jitter Mathematics

The retry delay calculation prevents synchronized retry storms by applying randomized bounded jitter:

$$\text{baseDelay} = \min\left(\text{initialDelay} \times 2^{\text{attempt}-1}, \;\text{maxDelay}\right)$$

$$\text{jitteredDelay} = \text{baseDelay} \times \left[1 + (2R - 1) \times \text{jitterFactor}\right]$$

*Where:*
- $\text{initialDelay} = 1{,}000\text{ ms}$ (configurable)
- $\text{maxDelay} = 60{,}000\text{ ms}$ (configurable)
- $\text{jitterFactor} = 0.2$ (yielding a $\pm 20\%$ randomized window)
- $R \in [0, 1)$ is a uniform pseudo-random number

---

## 4. API Reference Guide

All `/api/v1/*` routes require the `X-API-Key` header. Public endpoints (`/health/*`, `/metrics`) do not require authentication.

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/webhook-endpoints` | Registers an active webhook destination and generates an HMAC secret. | **Yes** (`X-API-Key`) |
| `POST` | `/api/v1/events` | Ingests an event idempotently and triggers subscriber fan-out. | **Yes** (`X-API-Key`) |
| `GET` | `/api/v1/deliveries/:deliveryId` | Retrieves status and metadata for a specific delivery. | **Yes** (`X-API-Key`) |
| `GET` | `/api/v1/deliveries/:deliveryId/attempts` | Retrieves paginated execution history and response payloads. | **Yes** (`X-API-Key`) |
| `GET` | `/api/v1/deliveries/dlq` | Lists dead-lettered deliveries with filtering and pagination. | **Yes** (`X-API-Key`) |
| `POST` | `/api/v1/deliveries/dlq/:deliveryId/replay` | Requeues a dead-lettered delivery back into BullMQ. | **Yes** (`X-API-Key`) |
| `GET` | `/health/ready` | Kubernetes readiness probe (checks PostgreSQL & Redis health). | No |
| `GET` | `/health/live` | Kubernetes liveness probe. | No |
| `GET` | `/metrics` | Prometheus metrics scrape target. | No |

---

### Sample cURL Requests

#### 1. Register a Webhook Endpoint
```bash
curl -X POST http://localhost:3000/api/v1/webhook-endpoints \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev_secret_key_123" \
  -d '{
    "url": "https://api.merchant.com/webhook",
    "subscribedEvents": ["payment.completed", "order.refunded"]
  }'
```
*Response (201 Created):*
```json
{
  "message": "Webhook endpoint created successfully",
  "data": {
    "id": "cuid_ep_9872",
    "url": "https://api.merchant.com/webhook",
    "secret": "8f4a180d28c9b9...32_byte_hex_secret",
    "subscribedEvents": ["payment.completed", "order.refunded"],
    "isActive": true,
    "createdAt": "2026-11-10T15:00:00.000Z"
  }
}
```

#### 2. Ingest an Event (Idempotent)
```bash
curl -X POST http://localhost:3000/api/v1/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev_secret_key_123" \
  -d '{
    "eventType": "payment.completed",
    "payload": {
      "orderId": "ord_88219",
      "amount": 4999,
      "currency": "INR"
    },
    "idempotencyKey": "idem_order_88219"
  }'
```
*Response (202 Accepted):*
```json
{
  "message": "Event accepted for processing",
  "data": {
    "id": "cuid_evt_1234",
    "eventType": "payment.completed",
    "matchedEndpoints": 1,
    "createdAt": "2026-11-10T15:00:01.000Z"
  }
}
```

#### 3. Replay a Dead-Lettered Delivery
```bash
curl -X POST http://localhost:3000/api/v1/deliveries/dlq/cuid_del_9981/replay \
  -H "X-API-Key: dev_secret_key_123"
```
*Response (200 OK):*
```json
{
  "message": "Delivery successfully requeued for processing",
  "data": {
    "deliveryId": "cuid_del_9981",
    "status": "PENDING"
  }
}
```

#### 4. Scrape Prometheus Metrics
```bash
curl -s http://localhost:3000/metrics | grep webhook_
```

---

## 5. Local Setup & Environment Guide

### Prerequisites
- **Node.js**: `v22.x` or later (tested on Node 22 & 24)
- **Docker & Docker Compose**: For PostgreSQL 17 & Redis 7

---

### Step-by-Step Installation

#### 1. Clone & Install Dependencies
```bash
git clone https://github.com/your-username/webhook-delivery-service.git
cd webhook-delivery-service
npm install
```

#### 2. Start Infrastructure Services
Spin up PostgreSQL 17 and Redis 7 containers:
```bash
docker compose up -d
```
Verify container health:
```bash
docker compose ps
```

#### 3. Configure Environment Variables
Create a local `.env` file based on `.env.example`:
```bash
cp .env.example .env
```
Ensure your `.env` contains the required settings:
```env
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://webhook_user:local_dev_password@localhost:5433/webhook_db?schema=public"
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
LOG_LEVEL=info
API_KEY=dev_secret_key_123

# Retry Policy Configuration
WEBHOOK_RETRY_INITIAL_DELAY_MS=1000
WEBHOOK_RETRY_MAX_DELAY_MS=60000
WEBHOOK_RETRY_JITTER_FACTOR=0.2
WEBHOOK_RETRY_MAX_ATTEMPTS=5
```

#### 4. Run Database Migrations
Initialize the PostgreSQL schema and generate Prisma client bindings:
```bash
npx prisma migrate dev
```

---

### Running the Services

#### 1. Start the Ingestion Gateway (HTTP API)
```bash
npm run dev
# Or for production:
npm run build && npm run start
```
*The API gateway listens on `http://localhost:3000`.*

#### 2. Start the Background Delivery Worker Daemon
In a separate terminal session:
```bash
npm run worker
# Or for production:
npm run start:worker
```

#### 3. (Optional) Run the Local Webhook Receiver
Test end-to-end HMAC verification using the built-in receiver:
```bash
npm run receiver
# Listens on http://localhost:4000/webhook
```

---

## 6. Testing & Quality Assurance

The codebase adheres to strict TypeScript standards (`tsc --noEmit`) and includes a zero-mock/isolated test suite running via Node's native test runner (`tsx --test`):

```bash
# 1. Typecheck the entire codebase
npm run typecheck

# 2. Execute the complete test suite
npm test
```

### Test Coverage Highlights (172 Tests Across 27 Suites)
- **SSRF & DNS Security**: IPv4/IPv6 classification, zero-prefix, loopback, private CIDR, IPv4-mapped IPv6, and dynamic DNS rebinding mitigation.
- **HMAC Signatures**: Verification of exact byte serialization, tampered payload rejection, and invalid signature isolation.
- **Retry Engine**: Exponential backoff math validation, bounded jitter constraints, and final-attempt DLQ transitions.
- **Concurrency & Tracing**: Isolation of concurrent requests under `AsyncLocalStorage`, request correlation, and safe JSON serialization.
- **API Hardening**: Timing attack resilience on `X-API-Key`, sliding-window rate limit triggers, and graceful shutdown signal verification.

---

## 7. License

Distributed under the **MIT License**. See `LICENSE` for details.


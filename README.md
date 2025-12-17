# Agora

Multisig wallet for Nockchain.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Rust](https://rustup.rs/) (for building WASM)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) - Install with: `cargo install wasm-pack`
- [Node.js](https://nodejs.org/) (v18+)

## Setup

### 1. Build WASM Component

The client requires the forked iris-wasm module from [Gohlub/iris-rs](https://github.com/Gohlub/iris-rs). Run the build script to clone, build, and copy the WASM files:

```bash
chmod +x scripts/build-wasm.sh
./scripts/build-wasm.sh
```

This script will:
- Clone the iris-rs repository
- Build the WASM module with `wasm-pack`
- Copy the output to `client/src/wasm/`
- Clean up the cloned repository

### 2. Start the API Server

```bash
cd server
docker-compose up --build
```

To reset the database:
```bash
docker-compose down -v && docker-compose up -d
```

### 3. Start the Client

```bash
cd client
npm install
npm run dev
```

## Project Structure

```
agora/
├── client/           # React frontend
│   └── src/
│       └── wasm/     # WASM bindings (built from iris-rs)
├── server/           # Rust API server
└── scripts/
    └── build-wasm.sh # WASM build script
```

## Features

- **Iris Wallet intergration**: Clients can use their Iris wallet to sign transactions
- **M-of-N Multisig**: Create wallets requiring multiple signatures
- **Transaction Proposals**: Propose transactions for group approval
- **Parallel Signing**: Signers can sign independently, signatures are merged at broadcast 
- **Direct Spend**: 1-of-n wallets can send directly without the proposal flow
- **Transaction History**: Track all wallet transactions
- **Note Consolidation**: Consolidate Notes associated with a multisig

## Supported Seed Destinations

When spending from a multisig, you can send to two types of destinations:

| Destination | Description | Use Case |
|-------------|-------------|----------|
| **`PKH`** | A PKH (public key hash). The lock root is derived via `firstName()`. | Send to someone's personal 'wallet' |
| **Lock Root** | A lock root hash used directly | Send to another multisig, consolidate notes, or any custom SpendCondition |

### How It Works

In Nockchain's UTXO model, every note has a `name = [lock-root, source]`. The lock-root determines who can spend the note.

- **Wallet Address**: We build a simple PKH SpendCondition and compute `firstName()` = `hash(true, hash(SpendCondition))`. This matches how wallets query for notes.
- **Lock Root**: Used as-is. Useful for sending to multisigs (whose lock root you know) or consolidating notes back to this wallet.

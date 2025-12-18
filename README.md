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

#### Note:
Make sure to properly set up environment variables:
```bash
cp .env.example .env
```
For development, set:
```bash
DATABASE_URL=sqlite:./data/data.db
API_PORT=3000
CORS_ORIGIN=http://localhost:5173
```
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
- **Direct Spend**: 1-of-n wallets can send directly without the proposal flow
- **Transaction History**: Track all multisig wallet transactions
- **Note Consolidation**: Consolidate Notes associated with a multisig 

# Architecture and Flow
Clients initiate multisig wallets by first creating an m-of-n spend condition, which is shared with the coordination server. Whenever a new client connects, the server checks whether the connected wallet PKH matches any existing spend condition, and on a match, shares the configuration across clients. Each client has the option to fund the multisig, and only after a valid note for the multisig is available (clients pool for notes associated with the multisig), can the clients propose transactions. Similarly to the spend conditions, the transaction proposals are also coordinated by the server, and each 'signer' can independently sign the proposal (through their Iris Wallet instance). Signatures are pooled and shared with the clients, and once the m-of-n threshold is met, any client can broadcast the transaction.

# Considerations
Transaction building and coordination logic have not audited and there are no privacy and security guarantees.

## Supported Seed Destinations
When spending from a multisig, you can send to two types of destinations:

| Destination | Description 
|-------------|-------------
| **`PKH`** | A PKH (public key hash). The lock root is derived via `firstName()`. 
| **Lock Root** | A lock root hash used directly | 


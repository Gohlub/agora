#!/bin/bash
# Build and copy WASM component for Agora
# This script clones iris-rs, builds the WASM module, copies it to the client, and cleans up

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGORA_DIR="$(dirname "$SCRIPT_DIR")"
CLIENT_WASM_DIR="$AGORA_DIR/client/src/wasm"
TEMP_DIR="$AGORA_DIR/.iris-rs-temp"
IRIS_REPO="https://github.com/Gohlub/iris-rs.git"

echo "🔧 Building iris-wasm for Agora..."

# Check for required tools
if ! command -v wasm-pack &> /dev/null; then
    echo "❌ Error: wasm-pack not found"
    echo "Install with: cargo install wasm-pack"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo "❌ Error: git not found"
    exit 1
fi

# Clean up any previous temp directory
if [ -d "$TEMP_DIR" ]; then
    echo "🧹 Cleaning up previous build..."
    rm -rf "$TEMP_DIR"
fi

# Clone the repository
echo "📥 Cloning iris-rs from $IRIS_REPO..."
git clone --depth 1 "$IRIS_REPO" "$TEMP_DIR"

# Build WASM
cd "$TEMP_DIR/crates/iris-wasm"
echo "📦 Running wasm-pack build (this may take a minute)..."
wasm-pack build --target web --release

# Copy to client
echo "📋 Copying WASM files to client..."
mkdir -p "$CLIENT_WASM_DIR"
cp pkg/iris_wasm.d.ts "$CLIENT_WASM_DIR/"
cp pkg/iris_wasm.js "$CLIENT_WASM_DIR/"
cp pkg/iris_wasm_bg.wasm "$CLIENT_WASM_DIR/"
cp pkg/iris_wasm_bg.wasm.d.ts "$CLIENT_WASM_DIR/"

# Create index.ts for consistent imports
echo "📝 Creating index.ts for WASM imports..."
cat > "$CLIENT_WASM_DIR/index.ts" << 'EOF'
// Re-export WASM module for consistent imports
export * from './iris_wasm';
export { default } from './iris_wasm';
EOF

# Clean up
echo "🧹 Cleaning up temporary files..."
cd "$AGORA_DIR"
rm -rf "$TEMP_DIR"

echo ""
echo "✅ WASM build complete!"
echo "   Files copied to: $CLIENT_WASM_DIR"
echo ""
echo "   - iris_wasm.js"
echo "   - iris_wasm.d.ts"
echo "   - iris_wasm_bg.wasm"
echo "   - iris_wasm_bg.wasm.d.ts"
echo "   - index.ts (created)"

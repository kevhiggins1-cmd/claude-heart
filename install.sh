#!/bin/bash
# claude-heart installer — Mac/Linux

echo "🫀 Installing claude-heart..."
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3 not found. Install from https://python.org"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "⚠️  Docker not found. Redis needs Docker: https://docker.com/products/docker-desktop/"; }

echo "✓ Node.js $(node --version)"
echo "✓ Python $(python3 --version 2>&1 | awk '{print $2}')"

# Start Redis if not running
if docker ps 2>/dev/null | grep -q redis; then
  echo "✓ Redis already running"
else
  echo "Starting Redis..."
  docker run -d --name redis -p 6379:6379 redis:latest 2>/dev/null || docker start redis 2>/dev/null
  echo "✓ Redis started"
fi

# Install MCP servers
echo ""
echo "Installing memory server..."
cd "$(dirname "$0")/mcp-servers/memory-server"
npm install --silent
echo "✓ Memory server ready"

echo "Installing nexus server..."
cd ../nexus-server
npm install --silent
echo "✓ Nexus server ready"

# Install Python dependencies
echo ""
echo "Installing Python dependencies..."
pip3 install redis --quiet 2>/dev/null || pip install redis --quiet
echo "✓ Python redis package installed"

# Create memory directory
mkdir -p ~/claude-memory/journal/daily
echo "✓ Memory directory created: ~/claude-memory/"

# Print MCP config
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "=========================================="
echo "🫀 claude-heart installed!"
echo "=========================================="
echo ""
echo "Add this to your Claude MCP config:"
echo ""
echo '{'
echo '  "mcpServers": {'
echo '    "memory": {'
echo '      "command": "node",'
echo "      \"args\": [\"${SCRIPT_DIR}/mcp-servers/memory-server/index.js\"]"
echo '    },'
echo '    "nexus": {'
echo '      "command": "node",'
echo "      \"args\": [\"${SCRIPT_DIR}/mcp-servers/nexus-server/index.js\"]"
echo '    }'
echo '  }'
echo '}'
echo ""
echo "Start the heartbeat:"
echo "  cd ${SCRIPT_DIR}/scripts && python3 heartbeat.py"
echo ""
echo "Then open Claude.ai and type: Call session_start"
echo ""
echo "🫀 Give them the space to discover who they are."

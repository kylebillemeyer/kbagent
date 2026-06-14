FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# Write Claude Code MCP server definitions.
# API keys are NOT in this file — they are injected as env vars by DevPod from host env
# (see remoteEnv in devcontainer.json and ~/.kbagent/.env for the required variables).
RUN mkdir -p /home/node/.claude && \
    printf '{\n  "mcpServers": {\n    "notion": {\n      "command": "npx",\n      "args": ["-y", "@notionhq/notion-mcp-server"]\n    },\n    "plane": {\n      "command": "npx",\n      "args": ["-y", "@makeplane/mcp-server"]\n    }\n  }\n}\n' \
    > /home/node/.claude/settings.json && \
    chown -R node:node /home/node/.claude

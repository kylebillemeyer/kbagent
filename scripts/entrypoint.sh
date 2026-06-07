#!/bin/bash
# Configure git to authenticate via GITHUB_TOKEN for all GitHub HTTPS operations
gh auth setup-git
exec "$@"

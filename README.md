# Outfnd

## installation

### 1) Install nvm (official script)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

### 2) Load nvm into your current shell (zsh)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

### 3) Install a compatible Node (pick one)
nvm install 22        # (Recommended) Node 22 LTS
or
nvm install 20.19.0   # Minimum for Vite 6

### 4) Use it and set as default
nvm use 22
nvm alias default 22

### 5) Verify
node -v   # should show v22.x or v20.19+

#!/usr/bin/env bash
set -euo pipefail

echo "[render-build] Baileys: no se instala Chrome ni Puppeteer."
echo "[render-build] Eliminando dependencias antiguas cacheadas..."
rm -rf node_modules

echo "[render-build] Instalando dependencias Node..."
npm ci --omit=dev --no-audit --no-fund

echo "[render-build] Build terminado."
